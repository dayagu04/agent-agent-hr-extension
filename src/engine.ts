// 投递引擎 —— 编排「扫描 → 规则过滤 → 匹配 → 投递 → 上报」全流程
//
// 设计：决策复用后端主项目模块（规则/匹配/招呼语/决策日志），
// 插件只做浏览器执行 + 如实上报，不在前端另造一套算法。
import type { ApplyResult, BasePlatform } from './platforms/base'
import type { ApplyOutcome, ApplyRule, JobCard, PluginConfig, ApplyProgress } from './types'
import {
  fetchGreeting,
  fetchRules,
  judgeJobs,
  logDecision,
  matchJobs,
  recordApplication,
} from './api'
import { cacheScannedJobs } from './ledger'
import { hhmmss } from './logger'
import { isAgentActionAllowed } from './contact-policy'

export class ApplyEngine {
  private aborted = false
  private rules: ApplyRule[] = []
  /** 实际生效的投递上限（= 用户配置） */
  private effectiveMaxApply = Number.MAX_SAFE_INTEGER
  /** 本次运行 id，贯穿决策日志（与后端 AgentTask.run_id 同角色） */
  private readonly runId = `plugin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  /** 本次运行实际尝试投递的岗位 id（编排器跨页续跑去重用） */
  readonly attemptedIds: string[] = []

  constructor(
    private platform: BasePlatform,
    private config: PluginConfig,
    private onProgress: (p: ApplyProgress) => void,
    /** 本次运行要跳过的岗位 id（已尝试过，防同页续跑重复投） */
    private readonly skipJobIds?: Set<string>,
    /** 本轮编排 run_id（后端用于标识本轮投递岗位，只回复本轮消息用） */
    private readonly orchestratorRunId = '',
  ) {}

  /** 中断标记；长睡眠期间也会被 waitAbortable 感知，不必等睡完 */
  abort() {
    this.aborted = true
  }

  /**
   * 可中断的等待。返回 false 表示等待期间被 abort。
   * 长睡眠（BOSS 保号间隔可达 200s）期间也要能感知「停止」，
   * 拆成 500ms 粒度轮询中断标记。
   */
  private async waitAbortable(ms: number): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (this.aborted) return false
      await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())))
    }
    return !this.aborted
  }

  /** 规则过滤：命中屏蔽公司/关键词/最低薪资则不投（与后端 _match_block_rule 同语义） */
  private matchBlockRule(job: JobCard): ApplyRule | null {
    const company = (job.company || '').toLowerCase()
    const title = (job.title || '').toLowerCase()
    const desc = (job.description || '').toLowerCase()

    for (const rule of this.rules) {
      const v = (rule.value || '').trim().toLowerCase()
      if (!v) continue
      if (rule.rule_type === 'block_company' && company.includes(v)) return rule
      if (rule.rule_type === 'block_keyword' && (title.includes(v) || desc.includes(v))) return rule
      if (rule.rule_type === 'min_salary') {
        // 从薪资文本解析上限（"15-25K" → 25），低于底线则拒投；
        // 解析不出（面议）视为未知，不据此拒投，避免误杀
        const m = (job.salary || '').match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)/)
        if (m) {
          let hi = parseFloat(m[2])
          if (/万/.test(job.salary || '')) hi *= 10 // 1.5-2万 → 20K
          const threshold = parseFloat(v)
          if (!Number.isNaN(threshold) && hi > 0 && hi < threshold) return rule
        }
      }
    }
    return null
  }

  async run(): Promise<ApplyProgress> {
    const progress: ApplyProgress = {
      scanned: 0,
      scanComplete: false,
      matched: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      unknown: 0,
      running: true,
      logs: [],
      blockedByQuality: [],
    }

    const log = (msg: string) => {
      progress.logs.unshift(`[${hhmmss()}] ${msg}`)
      if (progress.logs.length > 50) progress.logs.pop()
      this.onProgress({ ...progress })
    }

    this.effectiveMaxApply = this.config.maxApply

    // 加载后端投递规则（黑白名单/最低薪资），与 Web Agent 同源
    const rules = await fetchRules(this.config)
    if (rules === null) {
      if (this.config.matchEnabled) {
        // 后端 match 仍会做公司级拦截（黑名单/冷静期/频率/已投），只提示本地规则未生效
        log('⚠ 投递规则拉取失败：后端匹配仍会做公司级拦截，但本地黑名单/关键词规则本轮未生效')
        this.rules = []
      } else {
        // 匹配已关闭时没有后端兜底：继续跑会绕过用户黑名单，宁停勿放
        log('⚠ 投递规则拉取失败且匹配已关闭：为避免绕过黑名单，本次已停止，请检查网络后重试')
        progress.running = false
        this.onProgress({ ...progress })
        return progress
      }
    } else {
      this.rules = rules
      if (this.rules.length) log(`已加载 ${this.rules.length} 条投递规则`)
    }

    // 不做服务器端配额预检：插件在用户浏览器里直接投递，独立于网页端
    // Agent 的配额/限流体系，投递节奏只由用户配置控制。

    // 自动翻页：逐页处理直到达上限/无下一页/达页数上限
    const maxPages = this.config.autoPaginate ? Math.max(1, this.config.maxPages) : 1
    for (let page = 1; page <= maxPages; page++) {
      if (this.aborted) break
      if (progress.applied >= this.config.maxApply) {
        log(`已达投递上限 ${this.config.maxApply}，结束`)
        break
      }
      if (page > 1) log(`—— 第 ${page} 页 ——`)

      await this.runOnePage(progress, log)

      if (this.aborted) break
      if (progress.applied >= this.config.maxApply) break

      if (page < maxPages) {
        log('尝试翻到下一页...')
        const ok = await this.platform.nextPage()
        if (!ok) {
          log('没有下一页了，结束')
          break
        }
      }
    }

    log(
      `全部完成！共投递 ${progress.applied}，跳过 ${progress.skipped}，` +
        `未确认 ${progress.unknown}，失败 ${progress.failed}`,
    )
    progress.running = false
    this.onProgress({ ...progress })
    return progress
  }

  /** 处理当前页：扫描 → 匹配 → 投递 */
  private async runOnePage(
    progress: ApplyProgress,
    log: (msg: string) => void,
  ): Promise<void> {
    try {
      // 1. 扫描岗位
      log(`开始扫描 ${this.platform.name} 岗位...`)
      const jobs = await this.platform.scanJobs({ withDetail: this.config.scanWithDetail })
      progress.scanned = jobs.length
      progress.scanComplete = true
      log(`扫描到 ${jobs.length} 个岗位`)
      // 缓存本次扫描（聊天页按 boss.encryptJobId 反查标题/薪资，见 ledger.ts）
      await cacheScannedJobs(jobs)
      this.onProgress({ ...progress })

      if (jobs.length === 0) {
        // 区分「不在列表页」与「在列表页但选择器失效」，避免用户误判
        const onSearchPage = /sou\.zhaopin\.com|we\.51job\.com\/pc\/search|search\.51job\.com/.test(
          location.href,
        )
        if (!onSearchPage) {
          log('当前不是搜索结果页。插件只处理当前页面已有的岗位，')
          log('请先在站内搜索岗位（如点顶部「职位」搜索），到列表页再点开始。')
        } else {
          log('在列表页但未扫描到岗位 → 页面选择器可能已改版，请把控制台 [AAH] 日志发给开发者')
        }
        return
      }

      // 2. 批量匹配（分批提交，避免大批量走 LLM 精排超时）。
      //    设置里可关闭匹配度计算，但后端投递护栏仍必须执行。
      // 即使关闭匹配度，也必须调用后端做黑名单、冷静期、公司频率和
      // 重复投递护栏；evaluateMatch=false 只跳过昂贵的匹配评分。
      const results = await matchJobs(
        this.config,
        this.platform.code,
        jobs,
        (done, total) => {
          log(`${this.config.matchEnabled ? '匹配' : '护栏'}进度 ${done}/${total}`)
        },
        this.config.matchEnabled,
      )
      const scoreMap = new Map(results.map((r) => [r.platform_job_id, r]))
      if (this.config.matchEnabled) {
        log(`后端返回 ${results.length} 条评分`)
        if (results.length) {
          const scores = results.map((r) => r.score)
          const top = Math.max(...scores).toFixed(1)
          const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
          log(`评分：最高 ${top}，平均 ${avg}（阈值 ${this.config.threshold}）`)
        }
      } else {
        log('已关闭匹配度计算：仍执行后端投递护栏，安全检查通过后全部投递')
      }

      // LLM 低质量岗位判定：外包/批量招聘等（公司维度缓存，命中不重复判）
      const blockedReasonMap = new Map(
        results.filter((r) => r.blocked_reason).map((r) => [r.platform_job_id, r.blocked_reason as string]),
      )
      // 岗位级低质量判定：只拦截被判定为 low_quality 的具体岗位，
      // 不再「同公司任一岗低质 → 全公司拦截」（2026-08-07 与后端 judge-jobs 对齐）。
      const qualityBlocked = new Map<string, { reason: string; confidence?: number }>()
      if (this.config.qualityJudge) {
        const verdicts = await judgeJobs(this.config, jobs)
        if (verdicts === null) {
          // 降级可见：不能让外包/批量招聘拦截在网络抖动时无声失效
          log('⚠ 低质量岗位判定接口失败：本轮不拦截外包/批量招聘岗位，请检查网络')
        } else {
          for (const v of verdicts) {
            if (v.verdict !== 'low_quality') continue
            const key = v.platform_job_id
              ? `job:${v.platform_job_id}`
              : `co:${v.company}|${v.title}`
            qualityBlocked.set(key, { reason: v.reason || '外包/批量招聘', confidence: v.confidence })
          }
          if (qualityBlocked.size) {
            log(`质量拦截 ${qualityBlocked.size} 个岗位（岗位级判定，可复核）`)
          }
        }
      }

      // 3. 筛选推荐岗位（规则过滤 + 匹配阈值），跳过原因上报后端决策日志
      const recommended: Array<{ job: JobCard; score: number }> = []
      // Re-rendered/overlapping cards may repeat a stable ID within one scan.
      // Keep only its first entry before building the executable batch. Empty
      // IDs are not equivalent identities and must not collapse into one job.
      const seenJobIds = new Set<string>()
      let ruleBlocked = 0
      for (const job of jobs) {
        const r = scoreMap.get(job.platformJobId)

        // 已尝试过的岗位直接跳过（编排器同一页续跑时防止重复投递）
        if (this.skipJobIds?.has(job.platformJobId)) {
          progress.skipped++
          continue
        }

        if (job.platformJobId && seenJobIds.has(job.platformJobId)) {
          progress.skipped++
          this.platform.markCard(job, '#d1d5db')
          continue
        }
        if (job.platformJobId) seenJobIds.add(job.platformJobId)

        // 规则过滤优先于分数（用户明确设的底线不该被高分绕过）
        const hitRule = this.matchBlockRule(job)
        if (hitRule) {
          ruleBlocked++
          progress.skipped++
          this.platform.markCard(job, '#ef4444') // 红色=命中规则
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'rejected_by_rule',
            reason: `命中规则 ${hitRule.rule_type}=${hitRule.value}`,
            match_score: r?.score,
            details: { title: job.title, company: job.company, rule_id: hitRule.id },
          })
          continue
        }

        // 后端漏回任一岗位时不允许在“关闭匹配”模式下直接放行，否则一次
        // 部分响应就会绕过重复投递/公司频率护栏。
        if (!r) {
          progress.skipped++
          this.platform.markCard(job, '#f59e0b')
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'blocked_guard_unavailable',
            reason: '后端未返回该岗位的投递护栏结果',
            details: { title: job.title, company: job.company },
          })
          continue
        }

        // 公司级拦截（后端 match 结果标记）：黑名单 / 冷静期 / 频率上限 / 已投
        const blockedReason = blockedReasonMap.get(job.platformJobId)
        if (blockedReason) {
          progress.skipped++
          this.platform.markCard(job, '#d1d5db')
          const reasonText: Record<string, string> = {
            company_blacklisted: '公司已被拉黑',
            company_cooldown: '该公司处于冷静期',
            company_apply_limit: '该公司近期投递已达上限',
            already_applied: '该岗位已投递过',
          }
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'blocked_' + blockedReason,
            reason: reasonText[blockedReason] || blockedReason,
            match_score: r?.score,
            details: { title: job.title, company: job.company },
          })
          continue
        }

        // LLM 判定低质量岗位（外包/批量招聘话术等；仅拦截被判定岗位）
        const qKey = job.platformJobId
          ? `job:${job.platformJobId}`
          : `co:${job.company}|${job.title}`
        const qb = qualityBlocked.get(qKey)
        if (qb) {
          progress.skipped++
          this.platform.markCard(job, '#ef4444')
          progress.blockedByQuality = [
            ...(progress.blockedByQuality || []),
            {
              company: job.company,
              title: job.title,
              reason: qb.reason,
              confidence: qb.confidence,
            },
          ]
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'rejected_low_quality_company',
            reason: `LLM 判定低质量：${qb.reason || '外包/批量招聘'}`,
            match_score: r?.score,
            details: { title: job.title, company: job.company },
          })
          continue
        }

        if (!this.config.matchEnabled) {
          // 关闭匹配：不过滤分数，规则通过即投（score 记 0，账本里可区分）
          recommended.push({ job, score: 0 })
          this.platform.markCard(job, '#22c55e') // 绿色=全部投递
        } else if (r.recommend) {
          recommended.push({ job, score: r.score })
          this.platform.markCard(job, '#22c55e') // 绿色=推荐
        } else {
          progress.skipped++
          this.platform.markCard(job, '#d1d5db') // 灰色=跳过
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'rejected_low_score',
            reason: r
              ? `匹配分 ${r.score.toFixed(1)} 低于阈值 ${this.config.threshold}：${r.reason || ''}`
              : '未获得匹配分（低于后端初筛阈值）',
            match_score: r?.score,
            details: { title: job.title, company: job.company },
          })
        }
      }
      progress.matched = recommended.length
      log(
        this.config.matchEnabled
          ? `匹配通过 ${recommended.length} 个（阈值 ${this.config.threshold} 分），` +
            `低分跳过 ${progress.skipped - ruleBlocked} 个` +
            (ruleBlocked ? `，命中规则拒投 ${ruleBlocked} 个` : '')
          : `规则过滤通过 ${recommended.length} 个（匹配度已关闭），命中规则拒投 ${ruleBlocked} 个`,
      )
      this.onProgress({ ...progress })

      // 4. 逐个投递（拟人间隔 + 数量上限 + 如实记账）
      for (const { job, score } of recommended) {
        if (this.aborted) {
          log('已手动停止')
          break
        }
        if (progress.applied >= this.effectiveMaxApply) {
          log(`已达投递上限 ${this.effectiveMaxApply}，停止`)
          break
        }

        // 后端编排器通常已在下发批次前完成策略判断；这里再做一次本地
        // 护栏，覆盖旧页面缓存或用户在另一标签页刚修改策略的窗口。
        if (!isAgentActionAllowed(this.config.agentPolicy, 'apply')) {
          progress.skipped++
          this.attemptedIds.push(job.platformJobId)
          this.platform.markCard(job, '#d1d5db')
          log('跳过岗位（Agent 策略禁止投递）')
          void logDecision(this.config, {
            run_id: this.runId,
            platform: this.platform.code,
            platform_job_id: job.platformJobId,
            decision: 'policy_denied',
            reason: 'Agent 策略禁止 apply',
            details: { title: job.title, company: job.company },
          })
          continue
        }

        // 投递前更新当前岗位（实时显示用）
        progress.currentJob = { title: job.title, company: job.company, score }
        this.onProgress({ ...progress })

        log(
          this.config.matchEnabled
            ? `准备投递岗位（匹配分 ${score}）`
            : '准备投递岗位（匹配度已关闭）',
        )
        let outcome: ApplyOutcome = 'failed'
        let message = ''
        let greetingSent = false
        let alreadyApplied = false

        try {
          // 注入招呼语获取器：BOSS 建立会话需发首条消息，复用后端主项目话术
          const raw = await this.platform.applyJob(job, {
            getGreeting: () => isAgentActionAllowed(this.config.agentPolicy, 'send_greeting')
              ? fetchGreeting(this.config, this.platform.code, job)
              : Promise.resolve(''),
          })
          // 兼容旧签名（boolean）与新签名（ApplyResult）
          if (typeof raw === 'boolean') {
            outcome = raw ? 'applied' : 'failed'
          } else {
            const res = raw as ApplyResult
            outcome = res.outcome
            message = res.message || ''
            greetingSent = !!res.greetingSent
            alreadyApplied = !!res.alreadyApplied
          }
        } catch (e) {
          outcome = 'failed'
          message = (e as Error).message
        }

        // 无论成败都记入「已尝试」，同页续跑不再重复点它
        this.attemptedIds.push(job.platformJobId)

        // 投递完成，清除当前岗位
        progress.currentJob = null
        this.onProgress({ ...progress })

        // 该岗位此前已沟通过（如 BOSS「继续沟通」态）：不是本次投递失败，
        // 计为跳过；同时向后端补记真实投递（real_applied=True），
        // 让后续轮次的 already_applied 拦截直接生效，不再重复点击。
        if (alreadyApplied) {
          progress.skipped++
          this.platform.markCard(job, '#d1d5db') // 灰色=已投过
          log(`  ↳ 该岗位已沟通过，跳过（不重复骚扰 HR）`)
          try {
            await recordApplication(
              this.config, this.platform.code, job, score,
              'applied', message, false, this.orchestratorRunId,
              new URLSearchParams(location.search).get('query') || '',
            )
          } catch (e) {
            log(`  ↳ 记账失败（${(e as Error).name || 'Error'}）`)
          }
          this.onProgress({ ...progress })
          continue
        }

        // 计数与视觉标记按真实结果区分
        if (outcome === 'applied') {
          progress.applied++
          this.platform.markCard(job, '#3b82f6') // 蓝色=已投
          log(`  ↳ 成功${message ? `（平台消息长度 ${message.length}）` : ''}`)
        } else if (outcome === 'unknown') {
          // 未确认的尝试不推进投递目标（不 applied++），也不污染失败计数；
          // 后端记 real_applied=False，两者口径一致。
          progress.unknown++
          this.platform.markCard(job, '#a855f7') // 紫色=待核对
          log(`  ↳ 未能确认${message ? `（平台消息长度 ${message.length}）` : ''}，请在平台核对`)
        } else {
          progress.failed++
          this.platform.markCard(job, '#f59e0b') // 橙色=失败
          log(`  ↳ 失败${message ? `（平台消息长度 ${message.length}）` : ''}`)
        }

        // 上报记账：outcome 如实传，unknown/failed 不会写成 real_applied
        try {
          const rec = await recordApplication(
            this.config, this.platform.code, job, score, outcome, message, greetingSent,
            this.orchestratorRunId,
            new URLSearchParams(location.search).get('query') || '',
          )
          // 新服务端会把历史 failed/unknown 行升级成真实成功。该响应为了兼容
          // 旧客户端仍可能带 duplicate=true，必须先看 upgraded，避免误报“已投过”。
          if (rec.upgraded === true) log('  ↳ 记账结果已更新')
          else if (rec.duplicate) log('  ↳ 该岗位之前已投递过')
        } catch (e) {
          log(`  ↳ 记账失败（${(e as Error).name || 'Error'}）`)
        }
        this.onProgress({ ...progress })

        // 投递间隔：用户设置的单值（秒），内置 ±10% 随机抖动模拟真人节奏，
        // 是「投完一个岗位 → 投下一个」之间唯一的等待来源。
        const testMode = /[?&]testmode=1/.test(location.href)
        let waitMs = this.config.applyIntervalSeconds * 1000 * (0.9 + Math.random() * 0.2)
        if (this.platform.code === 'zhipin' && progress.applied < this.effectiveMaxApply) {
          if (testMode && waitMs > 10_000) waitMs = 10_000
          log(`  ↳ 投递间隔：等待 ${Math.round(waitMs / 1000)}s 后投下一个`)
        }
        if (!(await this.waitAbortable(waitMs))) {
          log('已手动停止')
          break
        }
      }

      log(`本页完成：累计投递 ${progress.applied}，跳过 ${progress.skipped}，失败 ${progress.failed}`)
    } catch (e) {
      // 单页出错不终止整个任务（下一页可能正常），只记日志
      log(`本页出错（${(e as Error).name || 'Error'}）`)
    }
    this.onProgress({ ...progress })
  }
}

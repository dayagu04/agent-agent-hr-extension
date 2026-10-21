// 后端通信 — 通过 platform-bridge 的网络层跨域调用后端 API
import type {
  ApplyOutcome,
  ApplyRule,
  HRMessageSummary,
  JobCard,
  MatchResultItem,
  PluginConfig,
  PlatformCode,
} from './types'
import { diag } from './logger'
import { network } from './platform-bridge'

/** 匹配走 LLM 精排，几十个岗位可能要 1-2 分钟，默认超时放宽到 180s */
const DEFAULT_TIMEOUT = 180000

/** 分批处理，避免单次请求过大导致超时 */
const MATCH_BATCH_SIZE = 10

function authHeaders(cfg: PluginConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.token}`,
  }
}

/** POST /api/auth/login — 用邮箱密码登录，换取 JWT Token（省去手动复制） */
export async function login(
  apiBase: string,
  email: string,
  password: string,
): Promise<{ token: string; user_id: number; username: string }> {
  const resp = await network.request({
    method: 'POST',
    url: `${apiBase}/api/auth/login`,
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ email, password }),
    timeout: DEFAULT_TIMEOUT,
  })
  if (resp.status !== 200) {
    let detail = ''
    try {
      detail = JSON.parse(resp.responseText).detail || ''
    } catch {
      /* ignore */
    }
    if (resp.status === 401) throw new Error('邮箱或密码错误')
    throw new Error(`登录失败 (${resp.status})${detail ? '：' + detail : ''}`)
  }
  return JSON.parse(resp.responseText)
}

/** GET /api/plugin/config — 拉取简历列表 + 默认阈值 */
export async function fetchPluginConfig(cfg: PluginConfig): Promise<{
  resumes: Array<{ id: number; name: string; skills_count: number }>
  default_threshold: number
  supported_platforms: string[]
  // 网站侧求职偏好（个人设置页维护），插件同步后与 Web Agent 行为一致
  preferences?: {
    keyword: string
    city: string
    threshold: number | null
    apply_limit: number | null
  }
  suggested_keywords?: string[]  // 从简历提取的 top 技能，供预填
  plugin_preferences?: Record<string, unknown>  // 网页端插件偏好（回复模式等）
}> {
  const resp = await network.request({
    method: 'GET',
    url: `${cfg.apiBase}/api/plugin/config`,
    headers: authHeaders(cfg),
    timeout: DEFAULT_TIMEOUT,
  })
  if (resp.status !== 200) {
    throw new Error(`拉取配置失败 (${resp.status})：请检查后端地址和 Token`)
  }
  return JSON.parse(resp.responseText)
}

/** POST /api/plugin/match — 批量匹配岗位 */
/**
 * 回传工具执行结果（agent 通过 GET /api/plugin/tools/result/{id} 读取）。
 * 失败只记一条日志，不影响工具本身的结果。
 */
export async function reportToolResult(
  cfg: PluginConfig,
  commandId: number,
  tool: string,
  result: { ok: boolean; data?: unknown; error?: string },
): Promise<void> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/tools/result`,
      headers: authHeaders(cfg),
      data: JSON.stringify({
        command_id: commandId,
        tool,
        ok: result.ok,
        data: result.data ?? null,
        error: result.error || '',
      }),
      timeout: 20000,
    })
    if (resp.status !== 200) diag('TOOL', `tool_result_upload status=${resp.status} tool=${tool}`)
  } catch (e) {
    diag('TOOL', `tool_result_upload status=error tool=${tool} error=${(e as Error).name || 'Error'}`)
  }
}

export async function matchJobs(
  cfg: PluginConfig,
  platform: PlatformCode,
  jobs: JobCard[],
  onBatch?: (done: number, total: number) => void,
  evaluateMatch = true,
): Promise<MatchResultItem[]> {
  // 分批：一次几十个岗位走 LLM 精排极易超时，切成小批稳定得多
  if (jobs.length > MATCH_BATCH_SIZE) {
    const all: MatchResultItem[] = []
    for (let i = 0; i < jobs.length; i += MATCH_BATCH_SIZE) {
      const chunk = jobs.slice(i, i + MATCH_BATCH_SIZE)
      const part = await matchJobs(cfg, platform, chunk, undefined, evaluateMatch)
      all.push(...part)
      onBatch?.(Math.min(i + MATCH_BATCH_SIZE, jobs.length), jobs.length)
    }
    return all
  }

  const payload = {
    resume_id: cfg.resumeId,
    platform,
    threshold: cfg.threshold,
    evaluate_match: evaluateMatch,
    jobs: jobs.map((j) => ({
      platform_job_id: j.platformJobId,
      title: j.title,
      company: j.company || '',
      city: j.city || '',
      salary: j.salary || '',
      // JD 全文优先（读详情才拿得到）；没有就退回列表页标签摘要
      description: j.jd || j.description || '',
      url: j.url || '',
    })),
  }
  // 仅记录结构摘要；岗位标题、公司、JD 与响应正文不得进入普通日志。
  diag(
    'API',
    `match 提交 ${payload.jobs.length} 个岗位 threshold=${payload.threshold} evaluate=${evaluateMatch}`,
    {
      missingId: payload.jobs.filter((job) => !job.platform_job_id).length,
      missingTitle: payload.jobs.filter((job) => !job.title).length,
    },
  )

  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/plugin/match`,
    headers: authHeaders(cfg),
    data: JSON.stringify(payload),
    timeout: DEFAULT_TIMEOUT,
  })
  if (resp.status !== 200) {
    diag('API', `match 失败 HTTP ${resp.status}`)
    throw new Error(`匹配请求失败 (${resp.status})`)
  }
  const data = JSON.parse(resp.responseText)
  diag('API', `match 返回 ${(data.results || []).length} 条评分`)
  return data.results || []
}

/**
 * GET /api/plugin/rules — 拉取投递过滤规则（黑白名单/最低薪资）。
 *
 * 失败返回 null（不再是空数组）：空数组会被当成「没有规则」静默放行，
 * 导致用户的黑名单在网络抖动瞬间被绕过。调用方需据此提示或中止。
 */
export async function fetchRules(cfg: PluginConfig): Promise<ApplyRule[] | null> {
  try {
    const resp = await network.request({
      method: 'GET',
      url: `${cfg.apiBase}/api/plugin/rules`,
      headers: authHeaders(cfg),
      timeout: 30000,
    })
    if (resp.status !== 200) {
      diag('API', `rules 拉取失败 HTTP ${resp.status}`)
      return null
    }
    return JSON.parse(resp.responseText).rules || []
  } catch (e) {
    diag('API', 'rules 拉取异常', { errorType: (e as Error).name || 'Error' })
    return null
  }
}

/** POST /api/plugin/greeting — 取打招呼语（BOSS 发首条消息用） */
export async function fetchGreeting(
  cfg: PluginConfig,
  platform: PlatformCode,
  job: JobCard,
): Promise<string> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/greeting`,
      headers: authHeaders(cfg),
      data: JSON.stringify({
        resume_id: cfg.resumeId,
        platform,
        platform_job_id: job.platformJobId,
        title: job.title,
        company: job.company || '',
        description: job.description || '',
      }),
    })
    if (resp.status !== 200) return ''
    return JSON.parse(resp.responseText).greeting || ''
  } catch {
    return ''
  }
}

/** POST /api/plugin/decision — 上报决策（跳过/失败原因），落后端决策日志 */
export async function logDecision(
  cfg: PluginConfig,
  payload: {
    run_id: string
    platform: PlatformCode
    platform_job_id: string
    decision: string
    reason: string
    match_score?: number
    details?: Record<string, unknown>
  },
): Promise<void> {
  try {
    await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/decision`,
      headers: authHeaders(cfg),
      data: JSON.stringify(payload),
      timeout: 20000,
    })
  } catch {
    /* 决策日志非关键路径，静默失败 */
  }
}

/** POST /api/plugin/chat/sync — 单条会话同步+回复生成（完整版：去重/已回复判定/评分） */
export interface ChatContactExchange {
  /** 后端策略是否明确允许点击；未提供时插件按本地 agentPolicy 判定。 */
  allowed?: boolean
  allow?: boolean
  /** 后端按请求文本计算出的允许渠道；存在时插件必须逐卡片校验。 */
  channels?: string[]
  requested_channels?: string[]
  channel?: string
  action_id?: number | null
  actionId?: number | null
  contact_action_id?: number | null
  contactActionId?: number | null
  idempotency_key?: string
  idempotencyKey?: string
  reason?: string
}

export interface SyncChatResponse {
  conversation_id: number | null
  new_messages: number
  intent: string
  confidence: number
  reply: string
  send_resume: boolean
  action_id: number | null
  message: string
  delete_after_send?: boolean
  /** Versioned fact/action response. Facts never grant permission by themselves. */
  facts?: Record<string, unknown> | null
  fact_context?: Record<string, unknown> | null
  personal_facts?: Record<string, unknown> | null
  actions_authoritative?: boolean
  action_plan_version?: number
  /** 新 Agent 联系方式动作；后端尚未统一字段时由插件兼容别名。 */
  contact_exchange?: ChatContactExchange | boolean | null
  send_contact?: ChatContactExchange | boolean | null
  contact?: ChatContactExchange | boolean | null
  actions?: Array<{
    type?: string
    action_type?: string
    payload?: ChatContactExchange
    [key: string]: unknown
  }>
}

export async function syncChatOne(
  cfg: PluginConfig,
  payload: {
    platform: string
    platform_job_id?: string
    company?: string
    job_title?: string
    messages: Array<{ sender: string; content: string; timestamp?: string }>
    auto_reply?: boolean
    min_reply_score?: number
    salary?: string
    city?: string
    run_id?: string
    reply_scope?: 'this_round' | 'all'
  },
): Promise<SyncChatResponse | null> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/chat/sync`,
      headers: authHeaders(cfg),
      data: JSON.stringify(payload),
      timeout: 60000,
    })
    if (resp.status !== 200) {
      // 服务端用 404 表达业务拒绝（例如 reply_scope=this_round 时不回非我方投递的会话），
      // 把 detail 带进日志，否则只有「HTTP 404」无法判断是路由不存在还是策略跳过。
      let reason = ''
      try {
        const body = JSON.parse(resp.responseText || '{}')
        reason = String(body.detail || '').slice(0, 160)
      } catch {
        reason = ''
      }
      diag('API', `chat/sync 失败 HTTP ${resp.status} reason=${reason || '-'}`)
      return null
    }
    return JSON.parse(resp.responseText)
  } catch (e) {
    diag('API', 'chat/sync 异常', { errorType: (e as Error).name || 'Error' })
    return null
  }
}

/** GET /api/plugin/chat/plan — 后端决策层：本轮需要打开处理的会话目标清单。
 *  插件只执行计划，不再本地猜测「哪个会话要回复/清理」。 */
export interface ChatPlanTarget {
  company: string
  job_title: string
  encrypt_job_id: string
  action: 'reply' | 'cleanup'
  last_message_at: number | null
  /** 后端给出的决策依据（aged_no_reply / hr_closed / rejected / low_quality）。
   *  插件只用于日志与删除对账，不据此改变行为 —— 业务判断已在后端完成。 */
  reason?: string
}

export interface ChatPlan {
  pending: number
  reply_scope: string
  targets: ChatPlanTarget[]
}

export async function fetchChatPlan(
  cfg: PluginConfig,
  opts: { reply_scope: 'this_round' | 'all' },
): Promise<ChatPlan> {
  const qs = new URLSearchParams({ reply_scope: opts.reply_scope })
  const resp = await network.request({
    method: 'GET',
    url: `${cfg.apiBase}/api/plugin/chat/plan?${qs.toString()}`,
    headers: authHeaders(cfg),
    timeout: 20000,
  })
  if (resp.status !== 200) {
    diag('API', `chat/plan 失败 HTTP ${resp.status}`)
    return { pending: 0, reply_scope: opts.reply_scope, targets: [] }
  }
  const data = JSON.parse(resp.responseText) as ChatPlan
  return {
    pending: Number(data.pending) || 0,
    reply_scope: data.reply_scope || opts.reply_scope,
    targets: Array.isArray(data.targets) ? data.targets : [],
  }
}


/**
 * POST /api/plugin/judge-jobs — LLM 判断岗位是否低质量（外包/批量招聘）。
 *
 * 失败返回 null（不再是空数组）：空数组会被当成「全部通过」静默放行，
 * 调用方需给出降级提示，让用户知道本轮没有质量拦截。
 */
export interface QualityVerdict {
  platform_job_id?: string
  company: string
  title: string
  verdict: 'low_quality' | 'ok' | 'unknown' | 'pending' | 'low_confidence'
  reason: string
  confidence?: number
  cached: boolean
}

export async function judgeJobs(
  cfg: PluginConfig,
  jobs: JobCard[],
): Promise<QualityVerdict[] | null> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/judge-jobs`,
      headers: authHeaders(cfg),
      data: JSON.stringify({
        jobs: jobs.map((j) => ({
          platform_job_id: j.platformJobId || '',
          company: j.company || '',
          title: j.title,
          // JD 全文优先（读详情才拿得到）；没有就退回列表页标签摘要
      description: j.jd || j.description || '',
          salary: j.salary || '',
        })),
      }),
      timeout: 120000,
    })
    if (resp.status !== 200) {
      diag('API', `judge-jobs 失败 HTTP ${resp.status}`)
      return null
    }
    return JSON.parse(resp.responseText).results || []
  } catch (e) {
    diag('API', 'judge-jobs 异常', { errorType: (e as Error).name || 'Error' })
    return null
  }
}

/**
 * GET /api/conversations/list — 拉最近会话，转成面板卡片用的 HR 消息摘要。
 *
 * 只打这一个端点：补打 /api/conversations/{id} 会对未回复消息调 LLM 生成
 * 回复草稿（每 30s 轮询 5 条 ≈ 每小时 600 次调用），正文由 /list 的
 * last_hr_message 字段直接给出，零额外查询。
 *
 * @param limit 取前几条（按 last_message_at 倒序，后端已排序）
 * @returns 摘要数组；请求失败返回 null（与「成功但空列表」区分，便于 UI 分别提示）
 */
export async function fetchHRMessages(
  cfg: PluginConfig,
  limit = 5,
  since?: number,
): Promise<HRMessageSummary[] | null> {
  try {
    const qs = new URLSearchParams()
    qs.set('limit', String(limit))
    if (since) qs.set('since', String(since))
    const resp = await network.request({
      method: 'GET',
      url: `${cfg.apiBase}/api/conversations/list?${qs.toString()}`,
      headers: authHeaders(cfg),
      timeout: 20000, // 纯 DB 查询
    })
    if (resp.status !== 200) {
      diag('API', `conversations/list 失败 HTTP ${resp.status}`)
      return null
    }
    const body = JSON.parse(resp.responseText)
    // 后端返回 {conversations: [...]}，不是裸数组
    const list = Array.isArray(body?.conversations) ? body.conversations : []
    const out: HRMessageSummary[] = []
    for (const c of list) {
      const hr = c?.last_hr_message
      if (!hr) continue // 没有任何 HR 消息的会话不进卡片列表
      const ts = Date.parse(hr.created_at || c.last_message_at || '')
      out.push({
        id: c.id,
        company: c.company || '未知公司',
        jobTitle: c.job_title || '',
        encryptJobId: c.encrypt_job_id || undefined,
        content: hr.truncated ? `${hr.content}…` : hr.content || '',
        timestamp: Number.isNaN(ts) ? 0 : ts,
        // 未读近似：HR 消息且未分类（intent 为空）。后端无已读字段。
        unread: !hr.intent,
        // 匹配分：后端可能返回 null（无投递记录），不要用 `|| 0` 塌成 0 分
        // ——那会把「无从判断」和「判过且很差」混为一谈，提示文案就分不开了。
        matchScore: typeof c.match_score === 'number' ? c.match_score : null,
        lastMessageAt: c.last_message_at || '',
      })
      if (out.length >= limit) break
    }
    diag('API', `HR 消息拉取 ${out.length} 条（未读 ${out.filter((m) => m.unread).length}）`)
    return out
  } catch (e) {
    diag('API', 'conversations/list 异常', { errorType: (e as Error).name || 'Error' })
    return null
  }
}

/** POST /api/plugin/chat/sent — 回报回复的真实发送结果（闭环留痕） */
export async function markChatSent(
  cfg: PluginConfig,
  actionId: number,
  success: boolean,
  error = '',
): Promise<void> {
  try {
    await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/chat/sent`,
      headers: authHeaders(cfg),
      data: JSON.stringify({ action_id: actionId, success, error }),
      timeout: 20000,
    })
  } catch {
    /* 留痕失败不影响会话继续 */
  }
}

// reportChatFollowUp 已删除（2026-08-14）：主动跟进整体移除，后端端点同步下线。

/** POST /api/plugin/chat/outcome — 批量上报会话的 HR 侧动作（结果回填，Phase 1）。 */
export async function reportChatOutcome(
  cfg: PluginConfig,
  payload: { run_id?: string; items: Array<{
    encrypt_job_id?: string
    company: string
    job_title: string
    outcome: 'unread' | 'read' | 'replied' | 'interview_invite' | 'rejected' | 'closed'
    detail?: string
  }> },
): Promise<void> {
  if (!payload.items || payload.items.length === 0) return
  try {
    await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/chat/outcome`,
      headers: authHeaders(cfg),
      data: JSON.stringify({ run_id: payload.run_id || '', items: payload.items }),
      timeout: 20000,
    })
  } catch {
    /* 结果回填失败不影响会话继续 */
  }
}

/**
 * POST /api/plugin/chat/mark-deleted — 会话已在 BOSS 端删除，同步标记后端记录。
 *
 * 失败时返回 null（调用方应保留待标记队列，稍后重试），成功（即使 marked=0）
 * 返回标记数。带一次快速重试：删除标记丢了对账是「死会话残留」的根因之一，
 * 不能静默吞掉。
 */
export async function markConversationDeleted(
  cfg: PluginConfig,
  payload: { company: string; job_title?: string; reason?: string; encrypt_job_id?: string },
): Promise<{ marked: number } | null> {
  const body = JSON.stringify({
    platform: 'zhipin',
    company: payload.company,
    job_title: payload.job_title || '',
    encrypt_job_id: payload.encrypt_job_id || '',
    reason: payload.reason || 'plugin_delete',
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await network.request({
        method: 'POST',
        url: `${cfg.apiBase}/api/plugin/chat/mark-deleted`,
        headers: authHeaders(cfg),
        data: body,
        timeout: 20000,
      })
      if (resp.status !== 200) {
        diag('API', `chat/mark-deleted 返回 HTTP ${resp.status}`)
      } else {
        const data = JSON.parse(resp.responseText) as { marked?: number }
        return { marked: Number(data.marked) || 0 }
      }
    } catch (e) {
      diag('API', `chat/mark-deleted 第 ${attempt + 1} 次尝试失败`, {
        errorType: (e as Error).name || 'Error',
      })
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 800))
  }
  diag('API', 'chat/mark-deleted 重试后仍失败，标记已留待下次对账补发')
  return null
}

/** POST /api/plugin/record — 记录一次投递 */
export async function recordApplication(
  cfg: PluginConfig,
  platform: PlatformCode,
  job: JobCard,
  matchScore: number,
  outcome: ApplyOutcome = 'applied',
  error = '',
  greetingSent = false,
  runId = '',
  keyword = '',
): Promise<{ success: boolean; duplicate: boolean; upgraded?: boolean; message?: string }> {
  const payload = {
    platform,
    platform_job_id: job.platformJobId,
    title: job.title,
    company: job.company || '',
    city: job.city || '',
    url: job.url || '',
    salary: job.salary || '',
    match_score: matchScore,
    resume_id: cfg.resumeId,
    // 如实上报结果：unknown/failed 不会在库里记成 real_applied
    outcome,
    error,
    greeting_sent: greetingSent,
    run_id: runId || null,
    keyword,
  }
  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/plugin/record`,
    headers: authHeaders(cfg),
    data: JSON.stringify(payload),
    timeout: DEFAULT_TIMEOUT,
  })
  if (resp.status !== 200) {
    // 引擎的 log() 只进面板，不上报；这里补一条 diag，否则台账记不进去时
    // 服务端日志里只有 access 400，看不到原因（如「请先创建 Agent」）。
    let detail = ''
    try {
      const d = JSON.parse(resp.responseText)?.detail
      detail = typeof d === 'string' ? d.slice(0, 80) : ''
    } catch {
      /* ignore */
    }
    diag('API', `plugin/record 失败 HTTP ${resp.status} outcome=${outcome} 原因=${detail || '-'}`)
    throw new Error(`记录投递失败 (${resp.status})`)
  }
  return JSON.parse(resp.responseText)
}

/**
 * POST /api/plugin/orchestrator/event — 上报编排器事件（阶段切换、批次完成、停止）。
 *
 * 返回 false 表示事件没有被服务端确认。调用方可以把事件留在本地 outbox，
 * 等下一次心跳重试；不能把网络失败当成“事件已经发生”。
 */
export async function reportOrchestratorEvent(
  cfg: PluginConfig,
  payload: {
    event: string
    timestamp: number
    phase: string
    stats?: Record<string, number>
    details?: Record<string, unknown>
    run_id?: string
    event_id?: string
  },
): Promise<boolean> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/orchestrator/event`,
      headers: authHeaders(cfg),
      data: JSON.stringify(payload),
      timeout: 20000,
    })
    if (resp.status !== 200) {
      diag('API', `编排事件上报返回 ${resp.status}（已留在本地待重试）`)
      return false
    }
    return true
  } catch {
    /* 上报失败不影响运行；编排器本地 outbox 会继续重试 */
    return false
  }
}

/** POST /api/plugin/chat/snapshot — 上报会话行全量快照（评估状态标签/DOM 用） */
export async function reportThreadSnapshot(
  cfg: PluginConfig,
  payload: {
    run_id: string
    url: string
    reason: string
    captured_at: string
    threads: unknown[]
  },
): Promise<void> {
  try {
    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/chat/snapshot`,
      headers: authHeaders(cfg),
      data: JSON.stringify(payload),
      timeout: 60000,
    })
    if (resp.status !== 200) {
      diag('API', `chat/snapshot 上报失败 HTTP ${resp.status}`)
    }
  } catch (e) {
    diag('API', 'chat/snapshot 上报异常', { errorType: (e as Error).name || 'Error' })
  }
}

/** POST /api/plugin/chat/reconcile — 对账：上报实际会话列表，返回该删除的 key */
export async function reconcileThreads(
  cfg: PluginConfig,
  payload: {
    threads: Array<{
      key: string
      company: string
      job_title: string
      unread: boolean
      last_ts: number | null
      last_msg_preview: string
    }>
  },
): Promise<{ to_delete: string[]; reconciled: number; created: number; marked_deleted: number }> {
  const resp = await network.request({
    method: 'POST',
    url: `${cfg.apiBase}/api/plugin/chat/reconcile`,
    headers: authHeaders(cfg),
    data: JSON.stringify(payload),
    timeout: 60000,
  })
  if (resp.status !== 200) {
    throw new Error(`reconcile HTTP ${resp.status}`)
  }
  return JSON.parse(resp.responseText)
}

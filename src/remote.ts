// 网页端远程管理：心跳上报 + 命令轮询执行
//
// 设计：网页端「我的助手」是插件的远程管理台（二者共用同一套后端）。
// - 插件每 1s 向后端 POST 一次心跳（平台/版本/阶段/统计），
//   顺手取回网页端入队的远程命令并执行；
// - 网页端通过 /api/plugin/commands 入队 orchestrator.* 命令，
//   插件下次心跳时消费，实现「网页控制插件」。
import { VERSION } from './version'
import { loadConfig, saveConfig, isConfigReady, applyPluginPreferences } from './config'
import { network, storage } from './platform-bridge'
import { diag, flushLogs } from './logger'
import {
  flushOrchestratorEvents, getCurrentJob, getOrchestrator, getOrchestratorSnapshot, resumeOrchestrator,
} from './orchestrator'
import { callTool, toolCatalog } from './tools'
import { reportToolResult } from './api'
import { detectPlatform } from './platforms/factory'

/** 当前页面平台代号（用于心跳上报） */
export function currentPlatformCode(): string {
  const url = location.href
  if (url.includes('zhipin.com')) return 'zhipin'
  if (url.includes('zhaopin.com')) return 'zhaopin'
  if (url.includes('51job.com')) return 'qiancheng'
  if (url.includes('liepin.com')) return 'liepin'
  return ''
}

interface RemoteCommand {
  id: number
  action: string
  payload: Record<string, unknown>
}

/** 与服务端 `/api/plugin/heartbeat` 协商的远程命令协议。 */
const PLUGIN_PROTOCOL_VERSION = 2
const PLUGIN_CAPABILITIES = ['command_ack_v2', 'tools_v1'] as const

interface PluginCompatibility {
  can_receive_commands?: boolean
  status?: string
  reason?: string
}

function parsePluginCompatibility(value: unknown): PluginCompatibility | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  return {
    can_receive_commands:
      typeof raw.can_receive_commands === 'boolean' ? raw.can_receive_commands : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 160) : undefined,
  }
}

const COMMAND_ACK_KEY = 'aah_remote_command_ack'
let heartbeatInFlight = false
const REMOTE_DIAG_DEDUPE_MS = 30_000
let lastProtocolDiagnosticKey = ''
let lastProtocolDiagnosticAt = 0

interface CommandAck {
  epoch: string
  id: number
}

function authHeaders(cfg: ReturnType<typeof loadConfig>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.token}`,
  }
}

/** 协议降级每秒随心跳返回时只保留低噪声诊断；原因变化或 30s 后再提示。 */
function protocolDiagnostic(
  key: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const now = Date.now()
  if (
    key === lastProtocolDiagnosticKey &&
    now - lastProtocolDiagnosticAt < REMOTE_DIAG_DEDUPE_MS
  ) {
    return
  }
  lastProtocolDiagnosticKey = key
  lastProtocolDiagnosticAt = now
  if (fields) diag('REMOTE', message, fields)
  else diag('REMOTE', message)
}

function clearProtocolDiagnostic(): void {
  lastProtocolDiagnosticKey = ''
  lastProtocolDiagnosticAt = 0
}

/** 上报一次心跳；返回的 commands 由调用方逐条执行 */
export async function reportHeartbeatAndPoll(): Promise<void> {
  // setInterval 不会等待 async 回调。慢网下若允许多个 15s 请求并发，后发的
  // stop 可能先执行、早发的 start 后执行，最终状态会逆转用户最后意图。
  if (heartbeatInFlight) return
  heartbeatInFlight = true
  try {
    const cfg = loadConfig()
    if (!isConfigReady(cfg)) return

    // 先冲刷页面跳转/断网期间积压的事件，让后端状态机在本次心跳里看到
    // 最新的 apply/chat 完成结果，再决定是否下发下一条动作。
    await flushOrchestratorEvents(cfg)

    // 顺带批量上报缓冲日志（logger 内部按 50 条/60 秒门控,非实时）
    void flushLogs()

    const orch = getOrchestrator(cfg)
    // 优先用单例状态;页面跳转后单例尚未恢复时,回退到持久化快照,
    // 保证网页端看到的阶段/运行态始终真实(修复「网页显示投递开始后退出」)。
    const live = orch.getState()
    const snap = await getOrchestratorSnapshot()
    const phase = live?.phase ?? snap?.phase ?? 'idle'
    const running = orch.isRunning() || !!snap?.running
    const currentJob = getCurrentJob()
    let commandAck = await storage.get<CommandAck>(COMMAND_ACK_KEY, { epoch: '', id: 0 })
    let ackCommandId = commandAck.id || 0
    const body = {
      platform: currentPlatformCode(),
      version: VERSION,
      protocol_version: PLUGIN_PROTOCOL_VERSION,
      capabilities: [...PLUGIN_CAPABILITIES],
      // 工具清单随心跳上报：agent 不用猜插件这版支持哪些原子操作
      tools: toolCatalog(),
      phase,
      running,
      visibility: document.visibilityState,
      applied_total: live?.stats.appliedTotal ?? snap?.appliedTotal ?? 0,
      replied_total: live?.stats.hrRepliesTotal ?? snap?.hrRepliesTotal ?? 0,
      send_resume_total: live?.stats.sendResumeTotal ?? snap?.sendResumeTotal ?? 0,
      pending_hr_messages: live?.stats.pendingHrMessages ?? snap?.pendingHrMessages ?? null,
      skipped_total: live?.stats.skippedTotal ?? snap?.skippedTotal ?? 0,
      failed_total: live?.stats.failedTotal ?? snap?.failedTotal ?? 0,
      goal_target: snap?.goalTarget ?? live?.goal?.target ?? null,
      keyword: live?.keywords[live.currentKeywordIndex] ?? snap?.keyword ?? '',
      page: live?.currentPage ?? snap?.page ?? 1,
      started_at: snap?.startedAt ?? live?.startedAt ?? null,
      last_error: snap?.lastError ?? null,
      current_job: currentJob
        ? { title: currentJob.title, company: currentJob.company, score: currentJob.score }
        : null,
      run_id: live?.runId ?? snap?.runId ?? null,
      ack_command_id: ackCommandId,
      ack_command_epoch: commandAck.epoch || null,
    }

    const resp = await network.request({
      method: 'POST',
      url: `${cfg.apiBase}/api/plugin/heartbeat`,
      headers: authHeaders(cfg),
      data: JSON.stringify(body),
      timeout: 15000,
    })
    if (resp.status !== 200) return
    const result = JSON.parse(resp.responseText) as Record<string, unknown>
    const compatibility = parsePluginCompatibility(result.plugin_compatibility)
    const commandEpoch = typeof result.command_epoch === 'string' ? result.command_epoch : ''

    // 命令协议必须由服务端明确确认。兼容性字段缺失、明确拒绝或缺少
    // epoch 都按不兼容处理：不执行命令、不推进本地 ACK，等待下一次握手。
    // 这样旧服务端、代理截断响应和部分部署都不会意外放行远程动作。
    if (!compatibility || compatibility.can_receive_commands !== true) {
      const reasonLength = compatibility?.reason?.length || 0
      const status = compatibility?.status || 'unconfirmed'
      protocolDiagnostic(
        `compatibility:${status}:${reasonLength}`,
        '远程命令未执行：服务端未确认兼容协议',
        { status, reasonLength },
      )
    } else if (!commandEpoch) {
      protocolDiagnostic('missing-command-epoch', '远程命令未执行：服务端缺少 command_epoch')
    } else {
      if (commandEpoch !== commandAck.epoch) {
        commandAck = { epoch: commandEpoch, id: 0 }
        ackCommandId = 0
      }
      const rawCommands = result.commands
      if (rawCommands !== undefined && !Array.isArray(rawCommands)) {
        protocolDiagnostic('invalid-commands', '远程命令未执行：commands 格式无效')
      } else {
        clearProtocolDiagnostic()
        const commands: RemoteCommand[] = Array.isArray(rawCommands) ? rawCommands : []
        for (const cmd of commands) {
          if (!cmd || typeof cmd !== 'object' || typeof cmd.id !== 'number' || typeof cmd.action !== 'string') {
            protocolDiagnostic('invalid-command-item', '远程命令未执行：命令格式无效')
            break
          }
          if (cmd.id <= ackCommandId) continue
          if (!await executeCommand(cfg, cmd)) break
          ackCommandId = cmd.id
          // 先持久化执行游标；即使命令触发跨页导航，新页面也能在下一次心跳 ACK。
          commandAck = { epoch: commandEpoch, id: ackCommandId }
          await storage.set(COMMAND_ACK_KEY, commandAck)
        }
      }
    }
    // 网页端插件偏好实时同步：网页端设置优先（任一字段变化都落盘，
    // 否则 cleanRead* 这类设置只进内存、刷新即丢）
    const rawPreferences = result.plugin_preferences
    if (rawPreferences && typeof rawPreferences === 'object' && !Array.isArray(rawPreferences)) {
      const next = applyPluginPreferences(cfg, rawPreferences as Record<string, unknown>)
      if (
        next.replyScope !== cfg.replyScope ||
        next.maxRepliesPerRound !== cfg.maxRepliesPerRound ||
        next.minReplyScore !== cfg.minReplyScore ||
        next.cleanReadConversations !== cfg.cleanReadConversations ||
        next.cleanReadAfterHours !== cfg.cleanReadAfterHours ||
        next.defaultSendResumeId !== cfg.defaultSendResumeId ||
        JSON.stringify(next.agentPolicy) !== JSON.stringify(cfg.agentPolicy)
      ) {
        saveConfig(next)
      }
    }
  } catch {
    // 心跳失败静默（网络/后端暂不可达时不影响插件主流程）
  } finally {
    heartbeatInFlight = false
  }
}

/** 执行一条远程命令（网页端入队） */
async function executeCommand(
  cfg: ReturnType<typeof loadConfig>,
  cmd: RemoteCommand,
): Promise<boolean> {
  const orch = getOrchestrator(cfg)
  try {
    switch (cmd.action) {
      case 'orchestrator.start': {
        if (!detectPlatform()) {
          console.warn('[remote] 未在招聘平台页面，无法启动编排')
          return false
        }
        const p = cmd.payload || {}
        const goal = {
          type: (p.goal_type as 'apply_count' | 'hr_reply_count' | 'time_elapsed') || 'apply_count',
          target: typeof p.goal_target === 'number' ? p.goal_target : cfg.maxApply || 20,
        }
        const keywords = Array.isArray(p.keywords)
          ? (p.keywords as string[]).filter(Boolean)
          : []
        // 城市只接受 BOSS 数字编码；城市名（如"杭州"）会污染 ?city= 参数，
        // 城市继续由当前 BOSS 页 URL 继承。
        const city =
          typeof p.city === 'string' && /^\d+$/.test(p.city.trim()) ? p.city.trim() : undefined
        const plan = Array.isArray(p.plan)
          ? (p.plan as Array<{ keyword: string; city: string; cityCode: string; quota: number }>)
          : undefined
        const quotaMode =
          p.quota_mode === 'per_combination' || p.quota_mode === 'total_llm'
            ? p.quota_mode
            : undefined
        await orch.start(goal, keywords, city, plan, quotaMode, p.chat_only === true, {
          chatInterval:
            typeof p.chat_interval === 'number' && p.chat_interval > 0
              ? Math.min(200, Math.max(1, Math.round(p.chat_interval)))
              : undefined,
          applyIntervalSeconds:
            typeof p.apply_interval_seconds === 'number' && p.apply_interval_seconds > 0
              ? Math.min(120, Math.max(1, Math.round(p.apply_interval_seconds)))
              : undefined,
          maxReplies:
            typeof p.max_replies === 'number' && p.max_replies > 0
              ? Math.min(50, Math.max(1, Math.round(p.max_replies)))
              : undefined,
          maxPagesPerKeyword:
            typeof p.max_pages_per_keyword === 'number' && p.max_pages_per_keyword > 0
              ? Math.min(100, Math.max(1, Math.round(p.max_pages_per_keyword)))
              : undefined,
          minReplyScore:
            typeof p.min_reply_score === 'number'
              ? Math.min(100, Math.max(0, Math.round(p.min_reply_score)))
              : undefined,
          replyScope: p.reply_scope === 'this_round' || p.reply_scope === 'all'
            ? p.reply_scope
            : undefined,
        })
        break
      }
      case 'orchestrator.pause':
        await orch.pause(typeof cmd.payload?.reason === 'string' ? cmd.payload.reason : '网页端远程暂停')
        break
      case 'orchestrator.resume':
        if (orch.getState()?.phase === 'paused') {
          // 暂停是用户主动暂停,用显式恢复(回到 search 续跑)
          await orch.resumeFromPause()
        } else {
          // 页面跳转/刷新后的正常续跑
          await resumeOrchestrator(cfg)
        }
        break
      case 'orchestrator.stop':
        await orch.stop(typeof cmd.payload?.reason === 'string' ? cmd.payload.reason : '网页端远程停止')
        break
      case 'orchestrator.action':
        // 后端 LangGraph 下发的执行指令（apply_batch / chat_snapshot / chat_reply / stop / pause）
        return await orch.applyBackendAction((cmd.payload || {}) as Record<string, unknown>)
      case 'tool.call': {
        // agent 直接调用一个原子工具。参数：{ name, args }
        // 不论工具成败都 ACK（返回 true）：不可撤回的工具不能因为 ACK 丢失而重试一次。
        const p = cmd.payload || {}
        const name = typeof p.name === 'string' ? p.name : ''
        const args = p.args && typeof p.args === 'object' ? (p.args as Record<string, unknown>) : {}
        if (!name) {
          diag('TOOL', 'tool name=- status=error error=name_required')
          return true
        }
        const result = await callTool(name, args)
        // 结果回传给服务端，agent 才能拿到数据（日志里只有摘要）
        await reportToolResult(cfg, cmd.id, name, result)
        diag('TOOL', `tool_call name=${name} ok=${result.ok ? 1 : 0}`)
        return true
      }
      case 'config.reload':
        // 网页端改了核心配置(单轮投递上限/阈值等):通知面板静默重拉配置,实时生效
        window.dispatchEvent(new CustomEvent('aah:config-reload'))
        break
      default:
        console.warn('[remote] 未知命令', cmd.action)
        return false
    }
    return true
  } catch (e) {
    console.warn('[remote] 命令执行失败', cmd.action, (e as Error).name || 'Error')
    diag('REMOTE', `命令执行失败 ${cmd.action}`, {
      errorType: (e as Error).name || 'Error',
    })
    void flushLogs({ force: true }).catch(() => undefined)
    return false
  }
}

/**
 * 心跳节拍器：优先用 Worker 里的定时器驱动。
 *
 * 实测（2026-10-21）：BOSS 标签页切到后台（visibility=hidden）后，页面主线程的
 * setInterval 被 Chrome 节流到约 1 分钟一跳，agent 调一个工具要等 60s 才被取走。
 * Worker 内的定时器不受这条节流约束，主线程只在收到 tick 时干活。
 * 创建 Worker 失败（CSP 禁 blob: 等）时退回主线程 setInterval，功能不变、只是后台会慢。
 */
function startTicker(intervalMs: number, onTick: () => void): void {
  try {
    const src = `setInterval(() => postMessage(0), ${Math.max(200, intervalMs)})`
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
    const worker = new Worker(url)
    worker.onmessage = onTick
    worker.onerror = () => {
      worker.terminate()
      window.setInterval(onTick, intervalMs)
    }
    return
  } catch {
    window.setInterval(onTick, intervalMs)
  }
}

/** 启动远程管理循环（心跳 + 命令轮询），页面挂载后调用一次 */
// 心跳间隔即"网页端指令生效延迟"上限：1s 一跳，指令最坏 1s 内执行。
// 后端 heartbeat 端点是纯内存操作（无 DB 写），1s 频率无数据库风险；
// 访问日志已对 heartbeat/status/config 降噪（server/main.py），日志量可控。
export function startRemoteLoop(intervalMs = 1000): void {
  startTicker(intervalMs, () => {
    void reportHeartbeatAndPoll()
  })
  void reportHeartbeatAndPoll()

  // 休眠唤醒恢复：浏览器后台标签页的定时器会被节流（可能 1 分钟才一跳），
  // 切回标签页/获得焦点/bfcache 恢复时立即补一次心跳，网页端状态马上回连。
  // 运行中的编排在冻结恢复后 JS 会自行继续，这里只补心跳、不重复 resume。
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void reportHeartbeatAndPoll()
    } else {
      // hidden 比 pagehide 更早，异步 GM 请求更有机会完成；仍只是 best effort。
      void flushLogs({ force: true }).catch(() => undefined)
    }
  }
  const onWake = (): void => {
    void reportHeartbeatAndPoll()
  }
  const onPageExit = (): void => {
    void flushLogs({ force: true }).catch(() => undefined)
  }
  // Page Lifecycle：后台标签页可能被浏览器整页冻结（Worker 一起停，不是节流）。
  // 2026-10-23 实测：页面 16 分钟内一行日志都没有（连每分钟的 HR 拉取都没有），
  // 期间下发的工具一直 queued。冻结前后各记一条，agent/开发者能直接看到「插件在睡」。
  let frozenAt = 0
  const onFreeze = (): void => {
    frozenAt = Date.now()
    diag('REMOTE', 'page_lifecycle status=frozen')
    void flushLogs({ force: true }).catch(() => undefined)
  }
  const onResume = (): void => {
    const sec = frozenAt ? Math.round((Date.now() - frozenAt) / 1000) : -1
    frozenAt = 0
    diag('REMOTE', `page_lifecycle status=resumed frozen_s=${sec}`)
    void reportHeartbeatAndPoll()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('freeze', onFreeze)
  document.addEventListener('resume', onResume)
  window.addEventListener('focus', onWake)
  window.addEventListener('pageshow', onWake)
  window.addEventListener('pagehide', onPageExit)
  window.addEventListener('beforeunload', onPageExit)
}

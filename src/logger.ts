// 页面内日志器 → 服务端批量上报
//
// 插件本地不再持久化日志、不再提供日志面板；diag() 把日志行放进内存缓冲，
// 攒够一批（≥50 条）或距上次上报超过 60 秒时，统一 POST /api/plugin/logs，
// 由后端按用户（JWT）落库。console.log 保留供开发期排查。
import { network } from './platform-bridge'
import { loadConfig, isConfigReady } from './config'
import { VERSION } from './version'

/** 攒够多少条触发一次上报 */
const FLUSH_THRESHOLD = 50
/** 距上次上报超过该时长则强制上报（毫秒） */
const FLUSH_INTERVAL_MS = 60_000
/** 内存缓冲上限：完整记录全部日志，不再因高频扫描挤掉关键诊断行。
 * 设大后只影响内存占用（单行 ≤4000 字符，5000 条上限可接受）；
 * 无后端时也不应无限膨胀，故仍保留上限。 */
const MAX_BUFFER = 5000

interface LogEntry {
  tag: string
  message: string
  run_id: string
  event_at: string
}

let buffer: LogEntry[] = []
let lastFlush = 0
let currentRunId = ''

interface PendingLogBatch {
  batchId: string
  logs: LogEntry[]
}

/**
 * 已从 buffer 取出、但尚未得到服务端 200 确认的批次。
 *
 * 网络超时并不代表服务端没收到；重试必须复用同一个 batch_id，让服务端可以
 * 幂等去重。旧实现把失败批次塞回 buffer、下次生成新 id，存在重复入库风险。
 */
let pendingBatch: PendingLogBatch | null = null
let flushPromise: Promise<void> | null = null
let forceRequested = false

/** Attach each event to the active orchestration round at the time it occurs. */
export function setLogRunId(runId: string): void {
  currentRunId = /^[A-Za-z0-9_-]{1,64}$/.test(runId) ? runId : ''
}

export interface FlushLogsOptions {
  /** 忽略 50 条/60 秒门槛，并把当前缓冲全部分批送出。 */
  force?: boolean
}

/**
 * 上报缓冲日志。普通调用受 50 条/60 秒门控；force 用于终态、关键失败和
 * 页面卸载前的 best effort。
 *
 * 并发调用共享同一个 Promise。若上传途中收到 force，请求循环会在当前批次
 * 结束后继续排空，而不是因为 flushing=true 静默丢掉这次强制语义。
 */
export function flushLogs(options: FlushLogsOptions = {}): Promise<void> {
  if (options.force) forceRequested = true
  if (flushPromise) return flushPromise
  if (!pendingBatch && buffer.length === 0) {
    forceRequested = false
    return Promise.resolve()
  }

  flushPromise = (async () => {
    while (pendingBatch || buffer.length > 0) {
      const forceThisPass = forceRequested
      forceRequested = false
      const now = Date.now()
      if (
        !forceThisPass &&
        buffer.length < FLUSH_THRESHOLD &&
        now - lastFlush < FLUSH_INTERVAL_MS
      ) {
        break
      }

      const cfg = loadConfig()
      if (!isConfigReady(cfg)) break

      if (!pendingBatch) {
        pendingBatch = {
          batchId: `b-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          logs: buffer.splice(0, FLUSH_THRESHOLD),
        }
      }
      const batch = pendingBatch
      let accepted = false
      try {
        const resp = await network.request({
          method: 'POST',
          url: `${cfg.apiBase}/api/plugin/logs`,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.token}`,
          },
          // plugin_version 让服务端日志文件能标出这批日志出自哪个构建。
          data: JSON.stringify({
            batch_id: batch.batchId,
            plugin_version: VERSION,
            logs: batch.logs,
          }),
          timeout: 15000,
        })
        accepted = resp.status === 200
      } catch {
        accepted = false
      }
      lastFlush = Date.now()
      if (!accepted) {
        // pendingBatch 原样保留；后续重试复用同一 batch_id。
        break
      }
      pendingBatch = null

      // force 要排空调用时已经在缓冲里的小尾批；上传期间新到达的日志若触发
      // 另一次 force，forceRequested 也会让循环继续。普通模式只自动续传满批。
      if (!forceThisPass && !forceRequested && buffer.length < FLUSH_THRESHOLD) break
      if (forceThisPass && buffer.length > 0) forceRequested = true
    }
  })().finally(() => {
    flushPromise = null
    // Promise 收尾的同一微任务里仍可能新来日志/force；再接一轮，避免竞态。
    if (!pendingBatch && buffer.length === 0) {
      forceRequested = false
    } else if (forceRequested || buffer.length >= FLUSH_THRESHOLD) {
      void flushLogs({ force: forceRequested })
    }
  })
  return flushPromise
}

/**
 * 记录一条诊断日志：进内存缓冲（攒批上报），并打 console 供开发排查。
 *
 * @param tag   模块标签，如 'BOSS' / 'ENGINE' / 'ORCH'
 * @param msg   人类可读消息
 * @param data  可选结构化数据（会被 JSON 化附在行尾）
 */
export function diag(tag: string, msg: string, data?: unknown): void {
  let line = msg
  if (data !== undefined) {
    try {
      const s = JSON.stringify(data)
      line += ` ${s.length > 600 ? s.slice(0, 600) + '…' : s}`
    } catch {
      line += ' [unserializable]'
    }
  }
  buffer.push({ tag, message: line, run_id: currentRunId, event_at: new Date().toISOString() })
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER)
  try {
    console.log(`[${tag}] ${line}`)
  } catch {
    /* ignore */
  }
  void flushLogs()
}

/** 统一时间戳格式 HH:MM:SS（24 小时制，供动作日志共用） */
export function hhmmss(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

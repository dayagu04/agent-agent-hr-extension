// 配置存储 — 基于油猴 GM_setValue/GM_getValue 持久化
import type { PluginConfig } from './types'
import { DEFAULT_AGENT_POLICY, normalizeAgentPolicy } from './contact-policy'

const CONFIG_KEY = 'aah_plugin_config'

/**
 * 服务器地址默认由构建期决定，也可在面板「连接与设置」里手工改（本地联调/切环境）。
 * - 生产构建：VITE_API_BASE 留空 → https://gudaya.chat
 * - 本地测试构建：npm run build:local（默认 http://127.0.0.1:8010；也可先设置 VITE_API_BASE）
 * - 用户在设置里填过地址后，以用户填的为准（见 loadConfig）。
 */
const BUILTIN_API_BASE: string = import.meta.env.VITE_API_BASE || 'https://gudaya.chat'

const DEFAULT_CONFIG: PluginConfig = {
  apiBase: BUILTIN_API_BASE,
  token: '',
  resumeId: null,
  threshold: 60,
  matchEnabled: true,
  maxApply: 20,
  chatCheckInterval: 5,
  maxPagesPerKeyword: 20,
  searchFilterQuery: '',
  scanWithDetail: false,
  applyIntervalSeconds: 8,
  autoPaginate: true,
  maxPages: 5,
  prefCity: '',
  // 默认不因城市不符而拒绝：宁可接受并标记，也不自动放弃机会
  rejectOffCityLocation: false,
  minReplyScore: 50,
  replyScope: 'this_round',
  maxRepliesPerRound: 10,
  cleanReadConversations: true,
  cleanReadAfterHours: 16,
  cleanupGuardSeconds: 3,
  defaultSendResumeId: null,
  resumeNames: {},
  qualityJudge: true,
  agentPolicy: DEFAULT_AGENT_POLICY,
}

export function loadConfig(): PluginConfig {
  try {
    const raw = GM_getValue(CONFIG_KEY, '')
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw as string)
    const cfg = { ...DEFAULT_CONFIG, ...parsed }
    // 服务器地址默认由构建期决定；用户在设置里手工填过则以用户的为准（本地联调/切环境用）。
    // 仅当存量配置里没有有效 apiBase 时，才回落到内置地址。
    if (typeof parsed.apiBase !== 'string' || !parsed.apiBase.trim()) {
      cfg.apiBase = BUILTIN_API_BASE
    }
    // 兼容旧配置：无 applyIntervalSeconds 时从旧的 delayMax / minIntervalSeconds 推导一次
    if (typeof parsed.applyIntervalSeconds !== 'number') {
      const oldSec = Math.max(
        (parsed.delayMax || 0) / 1000,
        parsed.minIntervalSeconds || 0,
      )
      cfg.applyIntervalSeconds = oldSec > 0
        ? Math.round(oldSec)
        : DEFAULT_CONFIG.applyIntervalSeconds
    }
    return cfg
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(cfg: PluginConfig): void {
  GM_setValue(CONFIG_KEY, JSON.stringify(cfg))
}

/** 网页端偏好（users.plugin_preferences）合并进本地配置，网页端设置优先。 */
export function applyPluginPreferences(
  cfg: PluginConfig,
  prefs: Record<string, unknown> | null | undefined,
): PluginConfig {
  if (!prefs || typeof prefs !== 'object') return cfg
  const next = { ...cfg }
  // Agent 策略由后端统一维护。支持新旧两种形态：
  // { agent_policy: {...}, contact: {...} } 以及 agent_policy.contact。
  if (prefs.agent_policy || prefs.contact) {
    next.agentPolicy = normalizeAgentPolicy(prefs.agent_policy, prefs.contact)
  }
  if (prefs.reply_scope === 'this_round' || prefs.reply_scope === 'all') {
    next.replyScope = prefs.reply_scope
  }
  if (typeof prefs.max_replies_per_round === 'number' && prefs.max_replies_per_round > 0) {
    next.maxRepliesPerRound = Math.min(50, Math.max(1, Math.round(prefs.max_replies_per_round)))
  }
  if (typeof prefs.min_reply_score === 'number') {
    next.minReplyScore = Math.min(100, Math.max(0, Math.round(prefs.min_reply_score)))
  }
  if (typeof prefs.clean_read_conversations === 'boolean') {
    next.cleanReadConversations = prefs.clean_read_conversations
  }
  if (typeof prefs.clean_read_after_hours === 'number' && prefs.clean_read_after_hours > 0) {
    next.cleanReadAfterHours = Math.min(24 * 30, Math.max(1, Math.round(prefs.clean_read_after_hours)))
  }
  if (typeof prefs.default_send_resume_id === 'number' && prefs.default_send_resume_id > 0) {
    next.defaultSendResumeId = prefs.default_send_resume_id
  }
  return next
}

export function isConfigReady(cfg: PluginConfig): boolean {
  return !!cfg.apiBase && !!cfg.token && !!cfg.resumeId
}

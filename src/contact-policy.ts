import type {
  AgentActionMode,
  AgentPolicy,
  ContactChannel,
} from './types'

/** 安全的本地默认值：全自动模式只会交换已在策略中配置的渠道。 */
export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  mode: 'full_auto',
  actions: {},
  contact: {
    channels: [],
    allowPlatformCard: true,
  },
}

const CHANNEL_ALIASES: Record<string, ContactChannel> = {
  phone: 'phone',
  mobile: 'phone',
  tel: 'phone',
  telephone: 'phone',
  电话: 'phone',
  手机: 'phone',
  手机号: 'phone',
  wechat: 'wechat',
  weixin: 'wechat',
  wx: 'wechat',
  微信: 'wechat',
  email: 'email',
  mail: 'email',
  邮箱: 'email',
  邮件: 'email',
  other: 'other',
  其他: 'other',
}

export function normalizeContactChannel(value: unknown): ContactChannel | null {
  const key = String(value ?? '').trim().toLowerCase()
  return CHANNEL_ALIASES[key] || null
}

function readChannels(raw: Record<string, unknown>): ContactChannel[] {
  const values: unknown[] = []
  if (Array.isArray(raw.channels)) values.push(...raw.channels)
  // 兼容管理端更直观的布尔配置：{ phone: true, wechat: true }。
  for (const key of ['phone', 'wechat', 'email', 'other']) {
    if (raw[key] === true) values.push(key)
  }
  return Array.from(new Set(values.map(normalizeContactChannel).filter((v): v is ContactChannel => !!v)))
}

function readActionMode(value: unknown): AgentActionMode | null {
  if (value === 'allow' || value === 'deny' || value === 'notify_after' || value === 'notify_before' || value === 'ask_once') {
    return value
  }
  // 旧管理端可能保存布尔动作开关。
  if (value === true) return 'allow'
  if (value === false) return 'deny'
  return null
}

/**
 * 将后端 plugin_preferences 的宽松 JSON 规整为插件内部策略。
 * 未配置渠道时仍保持 full_auto，但不会因为未知渠道而泄露联系方式。
 */
export function normalizeAgentPolicy(
  rawPolicy: unknown,
  rawContact?: unknown,
): AgentPolicy {
  const policy = rawPolicy && typeof rawPolicy === 'object'
    ? rawPolicy as Record<string, unknown>
    : {}
  const nestedContact = policy.contact && typeof policy.contact === 'object'
    ? policy.contact as Record<string, unknown>
    : {}
  const topContact = rawContact && typeof rawContact === 'object'
    ? rawContact as Record<string, unknown>
    : {}
  const contactRaw = Object.keys(topContact).length ? topContact : nestedContact
  const mode = policy.mode === 'manual' || policy.mode === 'guided' || policy.mode === 'assisted' || policy.mode === 'full_auto'
    ? policy.mode
    : 'full_auto'

  const actions: Record<string, AgentActionMode> = {}
  if (policy.actions && typeof policy.actions === 'object') {
    for (const [key, value] of Object.entries(policy.actions as Record<string, unknown>)) {
      const parsed = readActionMode(value)
      if (parsed) actions[key] = parsed
    }
  }
  // 兼容扁平写法：agent_policy.exchange_phone = "allow"。
  for (const key of ['exchange_phone', 'exchange_wechat', 'exchange_email', 'contact_exchange']) {
    const parsed = readActionMode(policy[key])
    if (parsed) actions[key] = parsed
  }

  const channels = readChannels(contactRaw)
  const allowRaw = contactRaw.allow_platform_card ?? contactRaw.allowPlatformCard
  const allowPlatformCard = typeof allowRaw === 'boolean' ? allowRaw : true
  return {
    mode,
    actions,
    contact: { channels, allowPlatformCard },
  }
}

/** 从 BOSS 卡片问题文本中提取明确渠道；泛化问题返回 null。 */
export function contactChannelFromQuestion(question: string): ContactChannel | null {
  const q = String(question || '').replace(/\s/g, '').toLowerCase()
  // Bare「电话」经常出现在电话面试/电话沟通卡片中，不能当成联系方式交换。
  // 只有明确的留/发/交换等动作才进入联系方式策略。
  const action = /交换|留下?|留个|提供|发送|发给|发我|给我|加个|加一下|添加/.test(q)
  const hasGenericContact = /联系方式/.test(q)
  const hasChannel = /微信|weixin|wechat|wx|邮箱|邮件|email|mail|手机号|手机|联系电话|mobile|telephone|tel/.test(q)
  if (!action || (!hasChannel && !hasGenericContact)) return null
  if (/微信|weixin|wechat|wx/.test(q)) return 'wechat'
  if (/邮箱|邮件|email|mail/.test(q)) return 'email'
  if (/电话|手机号|手机|联系电话|mobile|telephone|tel/.test(q)) return 'phone'
  return null
}

/**
 * 判断本地策略是否允许点击联系方式卡片。
 * full_auto 只放行已配置渠道；旧通知模式在插件端安全暂停。
 */
export function isContactExchangeAllowed(
  policy: AgentPolicy | null | undefined,
  channel: ContactChannel | null,
): boolean {
  const p = policy || DEFAULT_AGENT_POLICY
  if (p.contact?.allowPlatformCard === false) return false
  const actionKeys = channel
    ? [`exchange_${channel}`, 'contact_exchange']
    : ['contact_exchange']
  const explicit = actionKeys.map((key) => p.actions?.[key]).find((v) => v !== undefined)
  if (explicit === 'deny' || explicit === 'ask_once' || explicit === 'notify_before' || explicit === 'notify_after') return false
  if ((p.mode === 'manual' || p.mode === 'guided' || p.mode === 'assisted') && explicit !== 'allow') return false

  const channels = p.contact?.channels || []
  // 没有明确渠道时无法证明用户允许交换哪种联系方式；未知问题必须人工处理。
  if (!channel || !channels.length) return false
  return channels.includes(channel)
}

/**
 * 通用动作护栏。旧通知模式失去通知通道后必须暂停，不能悄悄执行。
 */
export function isAgentActionAllowed(
  policy: AgentPolicy | null | undefined,
  action: string,
): boolean {
  const p = policy || DEFAULT_AGENT_POLICY
  const explicit = p.actions?.[action]
  if (explicit === 'deny' || explicit === 'ask_once' || explicit === 'notify_before' || explicit === 'notify_after') return false
  if ((p.mode === 'manual' || p.mode === 'guided' || p.mode === 'assisted') && explicit !== 'allow') return false
  return true
}


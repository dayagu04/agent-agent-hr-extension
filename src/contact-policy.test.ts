import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_POLICY,
  contactChannelFromQuestion,
  isAgentActionAllowed,
  isContactExchangeAllowed,
  normalizeAgentPolicy,
} from './contact-policy'

describe('contact policy', () => {
  it('normalizes backend policy and boolean channel flags', () => {
    const policy = normalizeAgentPolicy(
      {
        mode: 'full_auto',
        actions: { exchange_phone: 'allow' },
      },
      { phone: true, wechat: false, allow_platform_card: true },
    )
    expect(policy.mode).toBe('full_auto')
    expect(policy.contact.channels).toEqual(['phone'])
    expect(isContactExchangeAllowed(policy, 'phone')).toBe(true)
    expect(isContactExchangeAllowed(policy, 'wechat')).toBe(false)
  })

  it('does not allow an unconfigured or unknown channel in full_auto', () => {
    expect(isContactExchangeAllowed(DEFAULT_AGENT_POLICY, 'phone')).toBe(false)
    const policy = normalizeAgentPolicy({}, { channels: ['email'] })
    expect(isContactExchangeAllowed(policy, 'phone')).toBe(false)
    expect(isContactExchangeAllowed(policy, null)).toBe(false)
  })

  it('preserves the backend guided mode and honors explicit action overrides', () => {
    const policy = normalizeAgentPolicy(
      { mode: 'guided', actions: { exchange_phone: 'allow' } },
      { channels: ['phone'] },
    )
    expect(policy.mode).toBe('guided')
    expect(isContactExchangeAllowed(policy, 'phone')).toBe(true)
  })

  it('respects explicit deny and disabled platform cards', () => {
    const denied = normalizeAgentPolicy(
      { mode: 'full_auto', actions: { exchange_phone: 'deny' } },
      { channels: ['phone'] },
    )
    expect(isContactExchangeAllowed(denied, 'phone')).toBe(false)
    const disabled = normalizeAgentPolicy({}, { channels: ['phone'], allowPlatformCard: false })
    expect(isContactExchangeAllowed(disabled, 'phone')).toBe(false)
  })

  it('extracts explicit channels from card text', () => {
    expect(contactChannelFromQuestion('是否方便交换微信？')).toBe('wechat')
    expect(contactChannelFromQuestion('请留下您的邮箱')).toBe('email')
    expect(contactChannelFromQuestion('电话面试时间方便吗？')).toBeNull()
    expect(contactChannelFromQuestion('请留下手机号')).toBe('phone')
    expect(contactChannelFromQuestion('方便交换联系方式吗')).toBeNull()
  })

  it('pauses retired notification modes and guided defaults', () => {
    const guided = normalizeAgentPolicy({ mode: 'guided' }, { channels: [] })
    expect(isAgentActionAllowed(guided, 'apply')).toBe(false)
    const legacy = normalizeAgentPolicy(
      { mode: 'full_auto', actions: { apply: 'notify_after', exchange_phone: 'notify_before' } },
      { channels: ['phone'] },
    )
    expect(isAgentActionAllowed(legacy, 'apply')).toBe(false)
    expect(isContactExchangeAllowed(legacy, 'phone')).toBe(false)
    const denied = normalizeAgentPolicy(
      { mode: 'full_auto', actions: { apply: 'deny', send_greeting: 'ask_once' } },
      { channels: [] },
    )
    expect(isAgentActionAllowed(denied, 'apply')).toBe(false)
    expect(isAgentActionAllowed(denied, 'send_greeting')).toBe(false)
    const manual = normalizeAgentPolicy({ mode: 'manual' }, { channels: [] })
    expect(isAgentActionAllowed(manual, 'apply')).toBe(false)
  })
})


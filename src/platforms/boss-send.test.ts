import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ diag: vi.fn() }))

import { readDeliveryState } from './boss-chat'

// 结构照 2026-10-21 实测：
// li.item-myself > .message-content > .text > i.message-status + p > span
function bubble(statusCls: string, statusText: string): HTMLElement {
  const li = document.createElement('li')
  li.className = 'message-item item-myself'
  const st = statusCls
    ? '<i class="message-status ' + statusCls + '">' + statusText + '</i>'
    : ''
  const body = '<p><span class="text-content">测试消息发送功能</span></p>'
  li.innerHTML = '<div class="message-content"><div class="text">' + st + body + '</div></div>'
  return li
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('message delivery state (BOSS receipt marker)', () => {
  it('reads the measured 送达 marker as delivered', () => {
    expect(readDeliveryState(bubble('status-delivery', '送达'))).toBe('delivered')
  })

  it('reads the measured 已读 marker as read', () => {
    expect(readDeliveryState(bubble('status-read', '已读'))).toBe('read')
  })

  it('reports none when BOSS has not stamped a receipt yet', () => {
    expect(readDeliveryState(bubble('', ''))).toBe('none')
  })
})

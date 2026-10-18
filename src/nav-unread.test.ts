import { afterEach, describe, expect, it } from 'vitest'
import { detectNavUnread } from './nav-unread'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('detectNavUnread', () => {
  it('reads a digit badge inside the chat nav link without relying on badge class names', () => {
    document.body.innerHTML = `
      <ul class="nav"><li><a href="/web/geek/chat"><span class="label">消息</span><i class="dot-x">12</i></a></li></ul>`
    const r = detectNavUnread()
    expect(r.count).toBe(12)
    expect(r.via).toBe('chat-link')
  })

  it('finds the badge as a sibling of the 消息 label when the link has no chat href', () => {
    document.body.innerHTML = `
      <div class="nav-item"><span>消息</span><span class="num">99+</span></div>`
    expect(detectNavUnread().count).toBe(99)
  })

  it('reports 0 (not -1) when the 消息 label exists but has no badge', () => {
    document.body.innerHTML = `<div class="nav-item"><span>消息</span></div>`
    const r = detectNavUnread()
    expect(r.count).toBe(0)
    expect(r.via).toBe('label-no-badge')
    expect(r.probe).toContain('labels=1')
  })

  it('ignores the plugin panel own unread text and reports structure on a miss', () => {
    document.body.innerHTML = `
      <div class="aah-root"><span>消息</span><span>7</span></div>
      <div class="other">岗位</div>`
    const r = detectNavUnread()
    expect(r.count).toBe(-1)
    expect(r.via).toBe('none')
    // 诊断串不能带页面文案或 {/[/< 开头片段，否则服务端会整体脱敏
    expect(r.probe).not.toMatch(/[{\[]|<\w/)
  })
})

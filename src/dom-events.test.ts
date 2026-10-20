import { afterEach, describe, expect, it, vi } from 'vitest'
import { clickDirect, realClick } from './dom-events'

const rect = { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40, toJSON: () => ({}) }

describe('realClick occlusion', () => {
  afterEach(() => {
    // jsdom 不实现 elementFromPoint，每个用例自己装
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint
  })

  it('still reaches the target when another element (our panel) sits on top of it', () => {
    // 2026-10-18 实测：插件面板盖住 BOSS 选择框的「发送」，点击落在面板上
    const send = document.createElement('button')
    const panel = document.createElement('div')
    document.body.append(send, panel)
    vi.spyOn(send, 'getBoundingClientRect').mockReturnValue(rect)
    ;(document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => panel
    const onSend = vi.fn()
    const onPanel = vi.fn()
    send.addEventListener('click', onSend)
    panel.addEventListener('click', onPanel)

    expect(realClick(send)).toBe('occluded')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onPanel).not.toHaveBeenCalled()
  })

  it('dispatches to the visible inner node when the target is not covered', () => {
    const row = document.createElement('div')
    const inner = document.createElement('span')
    row.appendChild(inner)
    document.body.appendChild(row)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect)
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(rect)
    ;(document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => inner
    const targets: EventTarget[] = []
    row.addEventListener('click', (e) => targets.push(e.target!))

    expect(realClick(row)).toBe('hit')
    expect(targets).toEqual([inner])
  })
})

describe('synthetic DOM clicks', () => {
  it('emits exactly one terminal click for an irreversible action', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    })
    const handler = vi.fn()
    button.addEventListener('click', handler)

    clickDirect(button)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('keeps the click bubbling for delegated Vue handlers', () => {
    const row = document.createElement('div')
    const label = document.createElement('span')
    row.appendChild(label)
    document.body.appendChild(row)
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    })
    const delegated = vi.fn()
    row.addEventListener('click', delegated)

    clickDirect(label)

    expect(delegated).toHaveBeenCalledTimes(1)
  })
})

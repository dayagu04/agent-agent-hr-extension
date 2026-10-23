// 点击事件工具 —— BOSS 等平台用 Vue 事件委托监听完整鼠标/指针事件序列，
// 裸 el.click() 不产生这些事件，合成点击需按真实序列派发。
import { assertToolExecutionActive } from './tool-execution-guard'

interface EventPoint {
  clientX: number
  clientY: number
}

function baseEvent(pos: EventPoint): EventInit & MouseEventInit {
  // 不能传 view: window —— 油猴沙箱里的 window 是包装对象，
  // 构造 MouseEvent 会抛 "Failed to convert value to 'Window'"。
  return { bubbles: true, cancelable: true, composed: true, clientX: pos.clientX, clientY: pos.clientY }
}

function pointerEvent(el: HTMLElement, type: string, pos: EventPoint, buttons: number): void {
  const init = {
    ...baseEvent(pos),
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons,
  } as PointerEventInit
  // 老浏览器无 PointerEvent 时忽略指针事件，后续 mouse 序列仍可触发 handler
  try {
    el.dispatchEvent(new PointerEvent(type, init))
  } catch {
    /* ignore */
  }
}

function centerOf(el: HTMLElement): EventPoint {
  const r = el.getBoundingClientRect()
  return {
    clientX: Math.round(r.left + (r.width || 1) / 2),
    clientY: Math.round(r.top + (r.height || 1) / 2),
  }
}

/**
 * 直接对元素派发完整点击序列，不经 elementFromPoint。
 *
 * 用于元素被其它节点遮挡或尺寸为 0（elementFromPoint 会命中别的节点）的场景。
 */
export function clickDirect(el: HTMLElement): void {
  assertToolExecutionActive()
  const pos = centerOf(el)
  pointerEvent(el, 'pointerover', pos, 1)
  pointerEvent(el, 'pointerenter', pos, 1)
  pointerEvent(el, 'pointerdown', pos, 1)
  el.dispatchEvent(new MouseEvent('mouseover', baseEvent(pos)))
  el.dispatchEvent(new MouseEvent('mouseenter', baseEvent(pos)))
  el.dispatchEvent(new MouseEvent('mousedown', { ...baseEvent(pos), button: 0, buttons: 1 }))
  pointerEvent(el, 'pointerup', pos, 0)
  el.dispatchEvent(new MouseEvent('mouseup', { ...baseEvent(pos), button: 0, buttons: 0 }))
  // 只派发一次终结 click。这里不能再补 el.click()：dispatchEvent(click)
  // 已经会触发元素自身及祖先上的委托监听器，再调用 click() 会让不可撤回的
  // 「同意 / 发送 / 删除」动作执行两次。前置 pointer/mouse 序列保留给依赖
  // 按下/抬起状态的 Vue 监听器。
  el.dispatchEvent(new MouseEvent('click', { ...baseEvent(pos), button: 0, detail: 1 }))
}

/**
 * 模拟真实鼠标点击：先滚动到元素，再把点击派发给「坐标处最上层的元素」。
 *
 * 平台的监听常挂在内层节点，直接点容器不会冒泡到正确的 handler，
 * 因此用 elementFromPoint 找到实际可见节点再派发。
 */
export function realClick(el: HTMLElement): 'hit' | 'occluded' {
  assertToolExecutionActive()
  // 脱敏 DOM fixture / 旧 WebView 可能没有 scrollIntoView；点击本身仍可执行。
  el.scrollIntoView?.({ block: 'center' })
  const pos = centerOf(el)
  // 插件面板可能正好盖住目标按钮（实测：简历选择框的「发送」被面板挡住，
  // elementFromPoint 拿到面板，BOSS 的 Vue 委托事件收不到点击）。
  // 取样前先让插件根节点不参与命中测试，拿到真实的最上层 BOSS 元素。
  const roots = [document.getElementById('aah-plugin-root'), document.getElementById('aah-test-host')]
  const prev = roots.map((r) => (r ? r.style.pointerEvents : ''))
  roots.forEach((r) => { if (r) r.style.pointerEvents = 'none' })
  let top: HTMLElement | null = null
  try {
    top = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(pos.clientX, pos.clientY) as HTMLElement | null
      : null
  } finally {
    roots.forEach((r, i) => { if (r) r.style.pointerEvents = prev[i] })
  }
  // 坐标处最上层不是目标自己或它的子节点 = 目标被挡住了（2026-10-18 实测：
  // 插件面板盖住了 BOSS 简历选择框的「发送」按钮，点击落在插件面板上，
  // 页面显示「已点击发送」但弹窗纹丝不动）。这时直接派发给目标本身。
  if (top && (top === el || el.contains(top))) {
    clickDirect(top)
    return 'hit'
  }
  clickDirect(el)
  return 'occluded'
}

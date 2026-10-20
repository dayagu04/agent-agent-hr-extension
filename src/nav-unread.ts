// BOSS 导航「消息」未读角标读取。
//
// 旧实现只认几个猜测的 class（.badge-count 等），真实页面一个都没命中，而且
// 未命中时什么都不记，无法定位原因。BOSS 页面开 DevTools 会被风控关页，
// 所以这里改成：
//   1. 不依赖角标 class：在「消息」导航项附近找「纯数字叶子节点」（12 / 99+）。
//   2. 未命中时生成一段脱敏的结构描述（标签链 + class 片段 + 叶子数），
//      由调用方自动上报，后端日志直接可读，不需要用户手动操作。

export interface NavUnreadResult {
  /** -1 = 未找到「消息」导航项；0 = 找到但无数字角标；>0 = 未读数 */
  count: number
  /** 命中路径：selector / chat-link / label / label-no-badge / none */
  via: string
  /** 脱敏的结构描述，仅用于诊断（不含页面文案） */
  probe: string
}

const KNOWN_SELECTORS = [
  'a[href*="chat"] .badge-count',
  '.nav-figure .badge-count',
  '[class*="message"] [class*="badge"]',
  'header [class*="badge"]',
]

/** 插件自己的面板也会显示「N 条未读」，必须排除，否则会读到自己。 */
const PLUGIN_ROOT = '.aah-root'

const DIGIT_TEXT = /^\d{1,4}\+?$/

function ownText(el: Element): string {
  let s = ''
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) s += n.textContent || ''
  }
  return s.replace(/\s/g, '')
}

function parseCount(raw: string): number {
  const n = parseInt(raw.replace(/[^\d]/g, ''), 10)
  return Number.isNaN(n) ? -1 : n
}

function inPlugin(el: Element): boolean {
  return !!el.closest(PLUGIN_ROOT)
}

/** scope 内第一个「无子元素且文本是纯数字」的叶子。 */
function findDigitLeaf(scope: Element): Element | null {
  for (const el of Array.from(scope.querySelectorAll('*'))) {
    if (el.children.length) continue
    if (DIGIT_TEXT.test((el.textContent || '').replace(/\s/g, ''))) return el
  }
  return null
}

/** 标签链描述：tag.class1.class2，class 截短；不输出任何文案。 */
function describe(el: Element | null): string {
  if (!el) return '-'
  const cls = Array.from(el.classList)
    .slice(0, 2)
    .map((c) => c.slice(0, 24))
    .join('.')
  return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase()
}

function chain(el: Element, depth: number): string {
  const parts: string[] = []
  let cur: Element | null = el
  for (let i = 0; i < depth && cur && cur !== document.body; i++) {
    parts.push(describe(cur))
    cur = cur.parentElement
  }
  return parts.join(' < ')
}

/** 自身文本是「消息」（允许尾随数字，如「消息12」）的元素。 */
function findMessageLabels(): Element[] {
  return Array.from(document.querySelectorAll('a, span, li, div, p, em, i')).filter(
    (el) => !inPlugin(el) && /^消息\d{0,4}\+?$/.test(ownText(el)),
  )
}

export function detectNavUnread(): NavUnreadResult {
  for (const sel of KNOWN_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (inPlugin(el)) continue
      const n = parseCount(el.textContent || '')
      if (n >= 0) return { count: n, via: `selector ${sel}`, probe: describe(el) }
    }
  }

  // 指向聊天页的导航链接，里面的纯数字叶子就是角标
  const chatLinks = Array.from(document.querySelectorAll('a[href*="/chat"]')).filter(
    (a) => !inPlugin(a),
  )
  for (const a of chatLinks) {
    const leaf = findDigitLeaf(a)
    if (leaf) {
      return { count: parseCount(leaf.textContent || ''), via: 'chat-link', probe: chain(leaf, 4) }
    }
  }

  // 「消息」文字所在节点，向上 3 层内找纯数字叶子（角标常是兄弟节点）
  const labels = findMessageLabels()
  for (const label of labels) {
    const inline = parseCount(ownText(label).replace(/^消息/, ''))
    if (inline > 0) return { count: inline, via: 'label-inline', probe: chain(label, 4) }
    let scope: Element | null = label
    for (let up = 0; up < 3 && scope; up++) {
      const leaf = findDigitLeaf(scope)
      if (leaf) {
        return { count: parseCount(leaf.textContent || ''), via: `label up=${up}`, probe: chain(leaf, 5) }
      }
      scope = scope.parentElement
    }
  }

  // 未命中：只报结构，供后端日志定位
  const first = labels[0]
  const leafCount = first?.parentElement
    ? Array.from(first.parentElement.parentElement?.querySelectorAll('*') || []).filter(
        (e) => !e.children.length,
      ).length
    : 0
  const probe =
    `labels=${labels.length} chatLinks=${chatLinks.length}` +
    ` labelChain=${first ? chain(first, 5) : '-'}` +
    ` chatLinkChain=${chatLinks[0] ? chain(chatLinks[0], 3) : '-'}` +
    ` scopeLeafs=${leafCount}`
  if (labels.length) return { count: 0, via: 'label-no-badge', probe }
  return { count: -1, via: 'none', probe }
}

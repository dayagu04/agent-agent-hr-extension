// BOSS 搜索页筛选条件（城市 / 求职类型 / 薪资待遇 / 工作经验 / 学历…）的读取探针。
//
// 目的：上游 agent 需要「自己设定筛选条件」。在没摸清 BOSS 筛选区长什么样之前，
// 任何点击都是猜。这里先做只读探测：把筛选分组、每组有多少可选项、选项是否带
// href（带 href 说明可以直接用 URL 参数设定，最稳），以及当前 URL 里已有哪些
// 筛选参数，全部写进日志。拿到真实数据后再实现「选中」。
//
// 只读：不点击任何筛选控件，不改 URL。

import { diag } from './logger'

export interface FilterOption {
  text: string
  /** 选项自带的链接（存在则可用 URL 参数直接生效） */
  href?: string
  selected: boolean
}

export interface FilterGroup {
  name: string
  options: FilterOption[]
}

/** 识别得了的筛选项标签 → 归一化分组名 */
const GROUP_NAMES = [
  '城市',
  '求职类型',
  '职位类型',
  '薪资待遇',
  '工作经验',
  '学历要求',
  '公司规模',
  '公司行业',
  '融资阶段',
]

/** URL 里非筛选项的参数，统计时排除 */
const NON_FILTER_PARAMS = new Set(['query', 'page'])

function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => (n.textContent || '').trim())
    .join('')
    .replace(/\s/g, '')
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** 找「城市」「薪资待遇」这类分组标签所在的节点（自身文本恰好等于标签） */
function findGroupLabel(name: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll('span, div, li, dt, em'))) {
    if ((el as HTMLElement).closest('.aah-root')) continue
    if (ownText(el) !== name) continue
    if (!visible(el)) continue
    return el as HTMLElement
  }
  return null
}

/** 从分组标签往上找容器：容器里应有多个可点击选项 */
function groupOptions(label: HTMLElement): FilterOption[] {
  let scope: HTMLElement | null = label.parentElement
  for (let up = 0; up < 3 && scope; up++) {
    const cand = Array.from(
      scope.querySelectorAll('a, li, span, div'),
    ) as HTMLElement[]
    const options: FilterOption[] = []
    for (const el of cand) {
      if (el === label || el.contains(label)) continue
      if (el.closest('.aah-root')) continue
      const t = ownText(el)
      if (!t || t.length > 20) continue
      if (t === label.textContent) continue
      if (!visible(el)) continue
      const interactive =
        el.tagName === 'A' ||
        el.getAttribute('role') === 'option' ||
        getComputedStyle(el).cursor === 'pointer' ||
        !!el.closest('a')
      if (!interactive) continue
      const anchor = (el.closest('a') as HTMLAnchorElement | null) || null
      options.push({
        text: t,
        href: anchor?.getAttribute('href') || undefined,
        selected: /(^|[-_\s])(active|selected|cur|current)([-_\s]|$)/.test(String(el.className || '')),
      })
    }
    // 去重（同一选项文字只留一个）并压在合理数量内
    const seen = new Set<string>()
    const unique = options.filter((o) => (seen.has(o.text) ? false : (seen.add(o.text), true)))
    if (unique.length >= 2) return unique.slice(0, 40)
    scope = scope.parentElement
  }
  return []
}

export function readSearchFilters(): FilterGroup[] {
  const groups: FilterGroup[] = []
  for (const name of GROUP_NAMES) {
    const label = findGroupLabel(name)
    if (!label) continue
    const options = groupOptions(label)
    if (options.length) groups.push({ name, options })
  }
  return groups
}

let lastProbeKey = ''

/**
 * 只读探测一次筛选区并写日志（同一 URL 参数组合只报一次）。
 *
 * 日志形如：
 *   filter_probe groups=4 城市:12opt,href=city,sel=1 薪资待遇:8opt,href=-,sel=0 params=query,city
 */
export function probeSearchFiltersOnce(reason: string): void {
  const params = new URLSearchParams(location.search)
  const paramKeys = Array.from(params.keys()).filter((k) => !NON_FILTER_PARAMS.has(k))
  const key = `${location.pathname}?${location.search}`
  if (key === lastProbeKey) return
  lastProbeKey = key

  const groups = readSearchFilters()
  if (!groups.length) {
    diag(
      'FILTER',
      `filter_probe status=none reason=${reason} params=${paramKeys.join(',') || '-'} ` +
        `candidates=${document.querySelectorAll('[class*="filter"], [class*="condition"]').length}`,
    )
    return
  }
  const parts = groups.map((g) => {
    const hrefKeys = new Set<string>()
    for (const o of g.options) {
      if (!o.href) continue
      const qs = o.href.split('?')[1] || ''
      for (const k of new URLSearchParams(qs).keys()) hrefKeys.add(k)
    }
    return `${g.name}:${g.options.length}opt,href=${Array.from(hrefKeys).join('+') || '-'},sel=${g.options.filter((o) => o.selected).length}`
  })
  diag(
    'FILTER',
    `filter_probe status=found reason=${reason} groups=${groups.length} ` +
      `${parts.join(' ')} params=${paramKeys.join(',') || '-'}`,
  )
}

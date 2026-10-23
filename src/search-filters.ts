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

// ---- 选中筛选项（点击式） -------------------------------------------------
//
// 实测结论（2026-10-20）：筛选项全部没有 href，不能靠 URL 参数设定；
// 交互形态是「点分组 → 弹出面板 → 点里面的具体选项」。这里按这个流程实现，
// 每一步都记日志，失败也能看出卡在哪一步。

import { realClick } from './dom-events'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 点开分组后面板里「自身文本完全等于目标」的可见选项 */
function findOptionInPanel(optionText: string, exclude: Element[]): HTMLElement | null {
  const want = optionText.replace(/\s/g, '')
  const cands = Array.from(document.querySelectorAll('a, li, span, div, label')) as HTMLElement[]
  for (const el of cands) {
    if (el.closest('.aah-root')) continue
    if (exclude.some((x) => x === el || x.contains(el))) continue
    if (ownText(el) !== want) continue
    if (!visible(el)) continue
    // 选项必须位于一个「新出现的面板」里：有 role 或 class 像下拉/弹层，
    // 或者它自己有 pointer 光标/在 li/a 里。
    const panel = el.closest(
      '[role="listbox"], [role="menu"], [class*="dropdown"], [class*="select"], ' +
        '[class*="popup"], [class*="panel"], [class*="option"], ul',
    )
    const interactive =
      el.tagName === 'A' || el.tagName === 'LI' || el.tagName === 'LABEL' ||
      getComputedStyle(el).cursor === 'pointer' || !!el.closest('a, li, label')
    if (!panel && !interactive) continue
    return el
  }
  return null
}

export interface FilterApplyResult {
  group: string
  option: string
  status: 'ok' | 'no_trigger' | 'no_panel' | 'no_option'
  urlChanged: boolean
}

/**
 * 依次选中一个或多个筛选项：点分组标签 → 等面板 → 点选项 →（有「确定」就点）。
 *
 * 只点文本完全匹配的选项；找不到就停下并记日志，不猜。
 */
export async function selectSearchFilter(
  group: string,
  option: string,
): Promise<FilterApplyResult> {
  const urlBefore = location.search
  const trigger = findGroupLabel(group)
  if (!trigger) {
    diag('FILTER', `filter_apply group=${group} status=no_trigger`)
    return { group, option, status: 'no_trigger', urlChanged: false }
  }
  const triggersBefore = Array.from(document.querySelectorAll('*'))
  const hit = realClick(trigger)
  diag('FILTER', `filter_apply group=${group} step=click_trigger hit=${hit}`)

  // 等面板出现并找到选项（面板可能是异步渲染的，最多约 2.4 秒）
  let target: HTMLElement | null = null
  for (let i = 0; i < 12 && !target; i++) {
    await sleep(200)
    target = findOptionInPanel(option, [trigger])
  }
  if (!target) {
    // 区分「面板没弹出来」和「面板出来了但没有这一项」
    const panelish = Array.from(document.querySelectorAll(
      '[role="listbox"], [role="menu"], [class*="dropdown"], [class*="popup"], [class*="panel"]',
    )).filter((el) => visible(el)) as HTMLElement[]
    const status = panelish.length ? 'no_option' : 'no_panel'
    diag(
      'FILTER',
      `filter_apply group=${group} option=${option} status=${status} ` +
        `panels=${panelish.length} newNodes=${document.querySelectorAll('*').length - triggersBefore.length} ` +
        `chain=${panelish[0] ? describeChain(panelish[0]) : '-'}`,
    )
    return { group, option, status, urlChanged: false }
  }

  realClick(target)
  await sleep(350)

  // 有些面板是「多选 + 确定」，选完要点确定；没有就不动
  const panel = target.closest(
    '[role="listbox"], [role="menu"], [class*="dropdown"], [class*="popup"], [class*="panel"]',
  ) as HTMLElement | null
  let confirmed = false
  if (panel) {
    const ok = (Array.from(panel.querySelectorAll('button, a, span, div')) as HTMLElement[]).find(
      (el) => /^(确定|确认|完成|应用)$/.test(ownText(el)) && visible(el),
    )
    if (ok) {
      realClick(ok)
      confirmed = true
      await sleep(350)
    }
  }

  const urlChanged = location.search !== urlBefore
  const params = new URLSearchParams(location.search)
  const filterKeys = Array.from(params.keys()).filter((k) => !NON_FILTER_PARAMS.has(k))
  diag(
    'FILTER',
    `filter_apply group=${group} option=${option} status=ok confirmed=${confirmed} ` +
      `urlChanged=${urlChanged} params=${filterKeys.join(',') || '-'}`,
  )
  return { group, option, status: 'ok', urlChanged }
}

/** 标签链（tag.class，不含文案），用于面板没认出来时取证 */
function describeChain(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
    const cls = Array.from(cur.classList).slice(0, 2).map((c) => c.slice(0, 20)).join('.')
    parts.push(cls ? `${cur.tagName.toLowerCase()}.${cls}` : cur.tagName.toLowerCase())
    cur = cur.parentElement
  }
  return parts.join(' < ')
}

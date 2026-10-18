// BOSS 会话删除链路：唤出操作按钮、定位「删除」项、处理确认弹窗
//
// 删除按三条路径依次尝试，全部作用于「目标会话行」：
//   1. deleteViaRowVue —— 直接调用行组件实例的 deleteBoss()
//   2. 列表项「···」菜单 —— 注入 CSS 绕过 :hover 闸门后点击
//   3. 会话头部菜单 —— 切到目标会话后点头部常驻菜单（带身份核对）
//
// 安全红线：删除不可撤回，任何路径都先确认目标身份再动作。
import { diag } from '../logger'
import { clickDirect, realClick } from '../dom-events'

const STYLE_ID = 'aah-force-operate-style'
/** 只作用在打了标记的那一行，避免整列表操作图标全亮 */
const MARK_CLASS = 'aah-op-target'
/** 强制展开头部下拉菜单所用的标记 */
const MARK_MENU = 'aah-menu-target'

const delay = (min: number, max: number) =>
  new Promise((r) => setTimeout(r, min + Math.random() * (max - min)))
const text = (el: Element | null | undefined) => (el?.textContent || '').trim()

/** 注入一次性样式：把标记行的操作按钮从 0 尺寸强制撑开为可见可点 */
function ensureForceStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const st = document.createElement('style')
  st.id = STYLE_ID
  // .user-operation 里有两张图（常态 / 悬停态），BOSS 原本二选一显示；
  // 必须显式藏掉常态图，否则它叠在同一坐标上把点击截走。
  st.textContent =
    `.${MARK_CLASS} .user-operation{display:flex!important;visibility:visible!important;` +
    `opacity:1!important;width:18px!important;height:20px!important;pointer-events:auto!important}` +
    `.${MARK_CLASS} .user-operation img.list-operate{display:none!important}` +
    `.${MARK_CLASS} .user-operation img.list-operate-hover{display:inline-block!important;` +
    `visibility:visible!important;opacity:1!important;width:18px!important;height:18px!important;` +
    `pointer-events:auto!important}`
  document.head.appendChild(st)
}

/** 注入头部菜单的强制展开样式（与列表按钮那套分开，互不影响） */
function ensureMenuStyle(): void {
  const id = `${STYLE_ID}-menu`
  if (document.getElementById(id)) return
  const st = document.createElement('style')
  st.id = id
  st.textContent =
    `.${MARK_MENU}{display:block!important;visibility:visible!important;opacity:1!important;` +
    `pointer-events:auto!important;max-height:none!important;overflow:visible!important}`
  document.head.appendChild(st)
}

/** 清掉标记（把这一行恢复成 BOSS 原本的悬停行为） */
export function unmarkOperateRow(item: HTMLElement): void {
  item.classList.remove(MARK_CLASS)
  for (const e of Array.from(item.querySelectorAll(`.${MARK_CLASS}`))) {
    e.classList.remove(MARK_CLASS)
  }
}

/**
 * 唤出会话项的「···」操作按钮。
 *
 * 按钮节点常驻 DOM 但被 CSS 压成 0 尺寸，显隐闸门是 CSS :hover ——
 * 合成事件无法改变浏览器悬停状态，因此注入 CSS 直接绕过闸门。
 * 撑开失败也返回节点：0 尺寸元素仍能接收派发的 click。
 */
export async function revealOperateBtn(item: HTMLElement): Promise<HTMLElement | null> {
  ensureForceStyle()
  item.classList.add(MARK_CLASS)

  const pick = (): HTMLElement | null => {
    const sels = [
      'img.list-operate-hover',
      '.user-operation img.icon-operate',
      '.user-operation img',
      '.user-operation',
    ]
    for (const s of sels) {
      const el = item.querySelector(s) as HTMLElement | null
      if (el) return el
    }
    return null
  }

  // 等 CSS 生效并让布局刷新（0→18px 是重排，需要一帧）
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 90))
    const el = pick()
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  const fallback = pick()
  if (fallback) {
    diag('CHAT', '操作按钮未能撑开尺寸，返回 0 尺寸节点直接派发点击')
  }
  return fallback
}

/** 像 boss 对象的东西：必须带 securityId（deleteBoss 内部读的就是它） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function looksLikeBoss(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.securityId === 'string'
}

/**
 * 在组件实例上找该行的 boss 对象。
 *
 * 只搜该实例自己的 data / $props / $attrs，不往 $parent 爬：
 * 父组件上的 currentBoss / list 是「当前选中会话」或整个列表，
 * 拿它去 deleteBoss() 会删错人。不往 BOSS 的对象上写任何字段。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findBossObject(vm: any): { obj: any; path: string } | null {
  for (const k of ['boss', 'friend', 'item', 'data', 'conversation', 'chat', 'row']) {
    if (looksLikeBoss(vm?.[k])) return { obj: vm[k], path: k }
    if (looksLikeBoss(vm?.$props?.[k])) return { obj: vm.$props[k], path: `$props.${k}` }
  }
  for (const src of [
    { o: vm, p: '' },
    { o: vm?.$props, p: '$props.' },
    { o: vm?.$attrs, p: '$attrs.' },
  ]) {
    if (!src.o || typeof src.o !== 'object') continue
    for (const k of Object.keys(src.o)) {
      if (!src.p && (k.startsWith('_') || k.startsWith('$'))) continue
      try {
        if (looksLikeBoss(src.o[k])) return { obj: src.o[k], path: `${src.p}${k}` }
      } catch {
        /* getter 可能抛，跳过 */
      }
    }
  }
  return null
}

/**
 * 直接调用会话行组件自己的 deleteBoss()。
 *
 * 行组件实例上挂着 deleteBoss（「删除」菜单项最终调用的方法），
 * 直接调用可跳过「唤按钮 → 点图标 → 等浮层 → 点删除」的不确定性，
 * 且作用对象就是这一行，不存在删错会话的可能。
 */
export function deleteViaRowVue(item: HTMLElement): boolean {
  const hosts = [
    item.querySelector('.gray.last-msg'),
    item.querySelector('.last-msg'),
    item.querySelector('.friend-content'),
    item,
  ].filter(Boolean) as HTMLElement[]

  for (const host of hosts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vm = (host as any).__vue__
    if (!vm || typeof vm.deleteBoss !== 'function') continue

    const found = findBossObject(vm)
    if (!found) {
      diag('CHAT', 'deleteViaRowVue 未能定位该行的 boss 对象（含 securityId），跳过')
      continue
    }

    // 安全校验：boss 对象的姓名必须出现在这一行的可见文本里，
    // 防止 findBossObject 拿到别的会话（父组件的 currentBoss 之类）。
    const bossName = String(found.obj.name || found.obj.bossName || '').replace(/\s/g, '')
    const rowText = (item.textContent || '').replace(/\s/g, '')
    if (bossName && !rowText.includes(bossName)) {
      diag('CHAT', 'deleteViaRowVue 已放弃：boss 对象与本行不匹配（防删错）', {
        bossNameLength: bossName.length,
      })
      continue
    }

    try {
      vm.deleteBoss(found.obj)
      diag('CHAT', 'deleteViaRowVue 已调用行组件 deleteBoss(boss)', {
        bossFrom: found.path,
        bossNamePresent: !!bossName,
      })
      return true
    } catch (e) {
      diag('CHAT', 'deleteViaRowVue 调用 deleteBoss() 抛异常', {
        errorType: (e as Error).name || 'Error',
      })
    }
  }
  return false
}

/** 该元素中心点处最上层的节点是否就是它自己（或其后代） */
export function isTopmostAtCenter(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return false
  const hit = document.elementFromPoint(
    Math.round(r.left + r.width / 2),
    Math.round(r.top + r.height / 2),
  )
  return !!hit && (hit === el || el.contains(hit))
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return false
  const st = getComputedStyle(el)
  return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) >= 0.1
}

/**
 * 在已弹出的操作浮层里找「删除」。
 *
 * 搜索范围限定在 .operation-container 内：会话头部还常驻一个折叠的 6 项菜单，
 * 其中的「删除」作用于当前打开的会话，全文档搜索会点错目标。
 */
export function findDeleteItemInPopup(): HTMLElement | null {
  const containers = Array.from(
    document.querySelectorAll('.operation-container'),
  ) as HTMLElement[]
  for (const box of containers) {
    if (!isVisible(box)) continue
    const items = Array.from(box.querySelectorAll('.operation-item')) as HTMLElement[]
    for (const it of items) {
      if (!isVisible(it)) continue
      if ((it.textContent || '').replace(/\s/g, '') === '删除') return it
    }
    // 结构变化时退回「浮层内文本为『删除』的最小可见节点」
    const leaves = (Array.from(box.querySelectorAll('*')) as HTMLElement[]).filter(
      (e) => !e.querySelector('*') && (e.textContent || '').replace(/\s/g, '') === '删除',
    )
    for (const lf of leaves) {
      if (isVisible(lf)) return (lf.parentElement as HTMLElement) || lf
    }
  }
  return null
}

/** 失败时的一次性取证：把定位所需的结构事实一次写进日志 */
export function dumpDeleteDiagnostics(item: HTMLElement, phase: string): void {
  const styleOf = (el: HTMLElement | null) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      cls: String(el.className || '').slice(0, 40),
      display: s.display,
      visibility: s.visibility,
      opacity: s.opacity,
      pointerEvents: s.pointerEvents,
      rect: `${Math.round(r.width)}x${Math.round(r.height)}`,
    }
  }

  const op = item.querySelector('.user-operation') as HTMLElement | null
  const imgs = Array.from(item.querySelectorAll('.user-operation img')) as HTMLElement[]
  let atPoint = '-'
  if (op) {
    const r = op.getBoundingClientRect()
    const el = document.elementFromPoint(
      Math.round(r.left + (r.width || 1) / 2),
      Math.round(r.top + (r.height || 1) / 2),
    ) as HTMLElement | null
    if (el) atPoint = `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 30)}`
  }

  diag('CHAT', `删除取证[${phase}] 样式与命中`, {
    marked: item.classList.contains(MARK_CLASS),
    styleInjected: !!document.getElementById(STYLE_ID),
    userOperation: styleOf(op),
    imgs: imgs.map((i) => styleOf(i)),
    imgCount: imgs.length,
    elementAtIconCenter: atPoint,
    operationContainers: document.querySelectorAll('.operation-container').length,
  })
  diag('CHAT', `删除取证[${phase}] 行结构摘要`, {
    tag: item.tagName.toLowerCase(),
    cls: String(item.className || '').slice(0, 80),
    descendantCount: item.querySelectorAll('*').length,
    htmlLength: (item.outerHTML || '').length,
    textLength: (item.textContent || '').length,
  })
}

/** 定位「确认删除吗？」弹窗：文案匹配且尺寸合理（避免命中 body） */
function findDeleteDialog(): HTMLElement | null {
  return (
    (Array.from(document.querySelectorAll('div,section')) as HTMLElement[]).find((d) => {
      const t = (d.textContent || '').replace(/\s/g, '')
      if (!/确认删除吗|从你的列表中删除|同时删除聊天记录/.test(t)) return false
      if (t.length > 120) return false // 太长说明是外层容器
      const r = d.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }) || null
  )
}

/**
 * 点掉「确认删除吗？」弹窗的「确定」。
 *
 * @param opts.gone 目标是否已从列表消失的判据。deleteViaRowVue 直接调组件方法时
 *                  BOSS 往往不弹确认窗 —— 每轮先查 gone，已消失立即返回，
 *                  不再固定空等 14 轮（约 5 秒）。
 */
export async function confirmDeleteDialog(opts?: { gone?: () => boolean }): Promise<boolean> {
  let dumpedMissing = false
  for (let i = 0; i < 14; i++) {
    if (opts?.gone?.()) return true
    await delay(250, 400)
    if (opts?.gone?.()) return true

    // 只在「真正的删除确认弹窗」范围内找「确定」。原来找不到弹窗就退回整个
    // document 搜任意「确定」叶子，会点到页面上无关的确定按钮并谎报成功——
    // 删除其实从未发生。宁可找不到也不乱点。
    const dialog = findDeleteDialog()
    if (!dialog) {
      // 第一次没探到弹窗时取证：把当前可见的弹窗类节点文案 dump 出来，
      // 便于判断是 BOSS 改了文案（findDeleteDialog 的正则失配）还是压根没弹窗。
      if (!dumpedMissing) {
        dumpedMissing = true
        dumpVisibleDialogs('未探到删除确认弹窗')
      }
      continue
    }

    const ok = (Array.from(dialog.querySelectorAll('button,span,div,a')) as HTMLElement[]).find(
      (e) => {
        if (e.querySelector('*')) return false // 只认叶子，防命中容器
        const t = text(e).replace(/\s/g, '')
        if (!/^(确定|确认)$/.test(t)) return false
        const r = e.getBoundingClientRect()
        return r.width > 1 && r.height > 1
      },
    )
    if (!ok) {
      diag('CHAT', '删除确认弹窗已出现但未找到「确定」按钮', {
        dialogTextLength: (dialog.textContent || '').replace(/\s/g, '').length,
        leafTexts: dialogLeafTexts(dialog),
      })
      continue
    }
    realClick(ok)
    await delay(500, 800)
    diag('CHAT', '已点击删除确认弹窗「确定」（已限定在确认弹窗内）')
    await dismissLeftoverDeleteDialogs()
    return true
  }
  return false
}

/** dump 当前所有可见、尺寸合理的「弹窗类」节点文案，用于诊断删除确认弹窗失配。 */
function dumpVisibleDialogs(phase: string): void {
  const cands = (Array.from(
    document.querySelectorAll('[class*="dialog"],[class*="modal"],[class*="popup"],[role="dialog"]'),
  ) as HTMLElement[])
    .filter((d) => {
      const r = d.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      const t = (d.textContent || '').replace(/\s/g, '')
      return t.length > 0 && t.length <= 160
    })
    .slice(0, 6)
    .map((d) => ({
      cls: String(d.className || '').slice(0, 50),
      textLength: (d.textContent || '').replace(/\s/g, '').length,
      // 文案本身可能含姓名/公司，统一脱敏：只保留结构性关键词命中情况
      hasDeleteWord: /删除/.test(d.textContent || ''),
      hasConfirmBtn: /确定|确认/.test(d.textContent || ''),
    }))
  diag('CHAT', `删除取证[${phase}] 可见弹窗节点`, {
    count: cands.length,
    dialogs: cands,
    anyDeleteWord: cands.some((c) => c.hasDeleteWord),
  })
}

/** 弹窗内叶子节点文本（仅结构性短词，脱敏：>6 字的文本只报长度，防泄露姓名/公司）。 */
function dialogLeafTexts(dialog: HTMLElement): string[] {
  return (Array.from(dialog.querySelectorAll('button,span,div,a')) as HTMLElement[])
    .filter((e) => !e.querySelector('*'))
    .map((e) => {
      const t = text(e).replace(/\s/g, '')
      if (!t) return ''
      return t.length <= 6 ? t : `[len=${t.length}]`
    })
    .filter(Boolean)
    .slice(0, 12)
}

/**
 * 清掉多余的「确认删除吗？」弹窗。
 *
 * 「删除」被触发多次时 Vue 会渲染两个弹窗，第一次「确定」只消掉最上面那个。
 * 残留弹窗点「取消」而非「确定」：会话已删掉，再点确定会删到下一个目标。
 */
export async function dismissLeftoverDeleteDialogs(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const dialog = findDeleteDialog()
    if (!dialog) return
    const cancel = (Array.from(dialog.querySelectorAll('button,span,div,a')) as HTMLElement[]).find(
      (e) => {
        if (e.querySelector('*')) return false
        const t = text(e).replace(/\s/g, '')
        if (!/^(取消|关闭)$/.test(t)) return false
        const r = e.getBoundingClientRect()
        return r.width > 1 && r.height > 1
      },
    )
    if (!cancel) {
      diag('CHAT', '残留删除弹窗里未找到「取消」，留给用户手动关闭')
      return
    }
    realClick(cancel)
    await delay(350, 550)
  }
}

/**
 * 经会话头部菜单删除当前打开的会话。
 *
 * 头部 6 项菜单（置顶/备注/不感兴趣/黑名单/删除/举报）常驻 DOM 且靠点击展开，
 * 绕开列表项按钮的 CSS :hover 闸门。它作用于「当前打开的会话」，
 * 因此调用方必须保证已切到目标会话并传入身份核对谓词。
 */
export async function clickDeleteInHeaderMenu(
  header: HTMLElement,
  verifyIdentity: () => boolean,
  insideList: (el: HTMLElement) => boolean,
): Promise<boolean> {
  if (!verifyIdentity()) {
    diag('CHAT', '头部菜单删除已中止：当前会话与目标不一致')
    return false
  }

  const delNodes = (Array.from(header.querySelectorAll('*')) as HTMLElement[]).filter(
    (e) =>
      !e.querySelector('*') &&
      (e.textContent || '').replace(/\s/g, '') === '删除' &&
      !insideList(e),
  )
  if (!delNodes.length) {
    diag('CHAT', '头部菜单里未找到「删除」项')
    return false
  }

  for (const n of delNodes) {
    if (isVisible(n)) {
      clickDirect(n)
      return true
    }
  }

  // 不可见 → 点开菜单触发器，展开判据是「删除项变可见」，点对即停手
  const menuReady = () => delNodes.some((n) => isVisible(n))
  const opened = await openHeaderMenu(header, insideList, menuReady)
  if (opened) {
    const vis = delNodes.find((n) => isVisible(n))
    if (vis) {
      clickDirect(vis)
      return true
    }
  }

  // 触发器不可用 → 沿祖先链标记并强制显示后再点（隐藏的往往是外层下拉容器）
  const target = delNodes[0]
  const marked: HTMLElement[] = []
  ensureMenuStyle()
  let cur: HTMLElement | null = target
  for (let i = 0; i < 6 && cur && cur !== header; i++) {
    cur.classList.add(MARK_MENU)
    marked.push(cur)
    cur = cur.parentElement
  }
  await new Promise((r) => setTimeout(r, 180))

  const vis = delNodes.find((n) => isVisible(n)) || target
  // 只点一个节点且只点一次：delNodes 里可能有多个「删除」文本节点，
  // 逐个点会让 Vue handler 触发多次，出现多个确认弹窗。
  clickDirect(vis)
  for (const m of marked) m.classList.remove(MARK_MENU)
  return true
}

/**
 * 点开会话头部的菜单触发器。
 *
 * 不写死 class：先按文案（「更多」/「···」）找，再按 operate/more/dot/menu 类名找。
 * 每点一个候选就检查一次是否展开，成功立即停止，避免连点把菜单又关掉。
 */
async function openHeaderMenu(
  header: HTMLElement,
  insideList: (el: HTMLElement) => boolean,
  isReady: () => boolean,
): Promise<boolean> {
  const byClass = (
    Array.from(
      header.querySelectorAll(
        '[class*="operate"],[class*="more"],[class*="dot"],[class*="setting"],[class*="menu"]',
      ),
    ) as HTMLElement[]
  ).filter((e) => {
    if (insideList(e)) return false
    const r = e.getBoundingClientRect()
    // 触发器是小图标；太大的是容器，点它可能命中别的东西
    return r.width >= 8 && r.width <= 48 && r.height >= 8 && r.height <= 48
  })

  const byText = (Array.from(header.querySelectorAll('*')) as HTMLElement[]).filter((e) => {
    if (insideList(e) || e.querySelector('*')) return false
    if (!/^(更多|···|\.\.\.|…)$/.test((e.textContent || '').replace(/\s/g, ''))) return false
    return isVisible(e)
  })

  const cands = [...byText, ...byClass]
  if (!cands.length) {
    diag('CHAT', '头部未找到菜单触发器候选')
    return false
  }
  for (const c of cands.slice(0, 6)) {
    clickDirect(c)
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 130))
      if (isReady()) return true
    }
  }
  diag('CHAT', '头部菜单触发器全部点过仍未展开')
  return false
}

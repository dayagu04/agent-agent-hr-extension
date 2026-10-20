// BOSS 附件简历：静默读取（不点击页面上任何东西）
//
// 为什么不能靠点「发简历」来读：账号里只有一份附件时，点一下 BOSS 就直接发出
// （2026-10-18 实测误发过一次）。所以有两条不点击的来源：
//   1. probeBossAttachments()：在 BOSS 页面自己的 Vue 数据（store + 组件树）里
//      找「元素带 .pdf/.doc 文件名的数组」。能不能找到取决于 BOSS 是否预先加载了
//      附件列表，要以实测日志为准。
//   2. rememberAttachments()：每次真实发简历弹出选择框时，把框里的列表存下来。
//      agent 托管发简历时会自然刷新这份缓存。
//
// 文件名属于用户材料：只存在本地、只在面板显示，日志里只记数量和字段名。

import { diag } from '../logger'
import { storage } from '../platform-bridge'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface BossAttachment {
  name: string
  /** BOSS 侧的附件 id（字段名未知，按 *id 猜；读不到为空串） */
  id: string
}

export interface AttachmentSnapshot {
  items: BossAttachment[]
  /** probe:store / probe:component / picker */
  via: string
  at: number
}

const FILE_RE = /\.(pdf|docx?|jpe?g|png)$/i
/** 只把这种「像代码标识符」的键名写进日志，防止把页面文案当键名带出去 */
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,40}$/
const CACHE_KEY = 'aah_boss_attachments'

function safeKey(k: string): string {
  return SAFE_KEY.test(k) ? k : '?'
}

function fileNameOf(item: Any): string {
  try {
    for (const v of Object.values(item)) {
      if (typeof v === 'string' && v.length <= 120 && FILE_RE.test(v.trim())) return v.trim()
    }
  } catch {
    /* getter 可能抛 */
  }
  return ''
}

function idOf(item: Any): string {
  try {
    for (const [k, v] of Object.entries(item)) {
      if (!/id$/i.test(k)) continue
      if ((typeof v === 'string' && v) || typeof v === 'number') return String(v)
    }
  } catch {
    /* ignore */
  }
  return ''
}

function isAttachmentList(v: unknown): v is Any[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 20 &&
    v.every((x) => x && typeof x === 'object' && !Array.isArray(x)) &&
    v.some((x) => fileNameOf(x))
  )
}

interface Hit {
  path: string
  list: Any[]
}

/** 在一个对象树里找附件数组（限深度、防环、跳过 DOM 节点和 Vue 内部字段） */
function scan(obj: Any, path: string, depth: number, seen: WeakSet<object>, hits: Hit[]): void {
  if (!obj || typeof obj !== 'object' || depth > 4 || hits.length >= 5) return
  if (seen.has(obj)) return
  seen.add(obj)
  if (typeof Node !== 'undefined' && obj instanceof Node) return
  if (isAttachmentList(obj)) {
    hits.push({ path, list: obj })
    return
  }
  if (Array.isArray(obj)) {
    // 大数组（会话列表、岗位列表）只看前几项，避免把整页数据扫一遍
    obj.slice(0, 3).forEach((x, i) => scan(x, `${path}.${i}`, depth + 1, seen, hits))
    return
  }
  let keys: string[] = []
  try {
    keys = Object.keys(obj).slice(0, 80)
  } catch {
    return
  }
  for (const k of keys) {
    if (k.startsWith('_') || k.startsWith('$')) continue
    let v: Any
    try {
      v = obj[k]
    } catch {
      continue
    }
    scan(v, `${path}.${safeKey(k)}`, depth + 1, seen, hits)
  }
}

/** 页面上任意一个 BOSS 的 Vue 2 实例 → $root（插件自己是 Vue 3，没有 __vue__） */
function findBossRootVm(): Any | null {
  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 2000)) {
    if ((el as HTMLElement).closest('.aah-root')) continue
    const vm = (el as Any).__vue__
    if (vm) return vm.$root || vm
  }
  return null
}

function toItems(list: Any[]): BossAttachment[] {
  return list
    .map((x) => ({ name: fileNameOf(x), id: idOf(x) }))
    .filter((x) => x.name)
}

function keysOf(list: Any[]): string {
  try {
    return Object.keys(list[0]).slice(0, 12).map(safeKey).join(',')
  } catch {
    return '-'
  }
}

/**
 * 不点击、不弹窗，从 BOSS 页面数据里读附件简历列表。
 * 读不到返回 null，并在日志里记下扫了多少组件，便于判断「BOSS 根本没预加载」。
 */
export function probeBossAttachments(): AttachmentSnapshot | null {
  const root = findBossRootVm()
  if (!root) {
    diag('CHAT', 'attach_probe status=no_vue')
    return null
  }
  const hits: Hit[] = []
  const seen = new WeakSet<object>()

  const state = root.$store?.state
  if (state) scan(state, 'store', 0, seen, hits)
  const via = hits.length ? 'probe:store' : 'probe:component'

  // 组件树 BFS（$data + $props），限制组件数量
  let components = 0
  if (!hits.length) {
    const queue: Any[] = [root]
    while (queue.length && components < 600 && hits.length < 5) {
      const vm = queue.shift()
      components++
      const name = safeKey(String(vm.$options?.name || vm.$options?._componentTag || 'anon'))
      scan(vm.$data, `${name}.data`, 1, seen, hits)
      scan(vm.$props, `${name}.props`, 1, seen, hits)
      for (const child of vm.$children || []) queue.push(child)
    }
  }

  if (!hits.length) {
    diag('CHAT', `attach_probe status=none store=${state ? 1 : 0} components=${components}`)
    return null
  }
  const best = hits[0]
  const items = toItems(best.list)
  diag(
    'CHAT',
    `attach_probe status=found via=${via} lists=${hits.length} count=${items.length} ` +
      `path=${best.path} keys=${keysOf(best.list)}`,
  )
  return { items, via, at: Date.now() }
}

/** 打开着的选择框背后的 Vue 数据：记下字段路径，帮下次在 store 里定位同一份数据 */
export function probeDialogVue(dialog: HTMLElement): void {
  let el: HTMLElement | null = dialog
  for (let up = 0; up < 6 && el; up++, el = el.parentElement) {
    const vm = (el as Any).__vue__
    if (!vm) continue
    const hits: Hit[] = []
    const seen = new WeakSet<object>()
    scan(vm.$data, 'data', 1, seen, hits)
    scan(vm.$props, 'props', 1, seen, hits)
    if (hits.length) {
      const name = safeKey(String(vm.$options?.name || vm.$options?._componentTag || 'anon'))
      diag(
        'CHAT',
        `attach_probe status=found via=dialog_vue up=${up} component=${name} ` +
          `path=${hits[0].path} count=${toItems(hits[0].list).length} keys=${keysOf(hits[0].list)}`,
      )
      return
    }
  }
  diag('CHAT', 'attach_probe status=none via=dialog_vue')
}

export async function rememberAttachments(snapshot: AttachmentSnapshot): Promise<void> {
  if (!snapshot.items.length) return
  try {
    await storage.set(CACHE_KEY, snapshot)
  } catch {
    /* 缓存失败不影响发送 */
  }
}

export async function lastKnownAttachments(): Promise<AttachmentSnapshot | null> {
  try {
    const v = await storage.get<AttachmentSnapshot | null>(CACHE_KEY, null)
    return v && Array.isArray(v.items) ? v : null
  } catch {
    return null
  }
}

// 开发期自动更新：已安装的脚本在每次页面加载时，先去本地开发服务器拉最新构建并直接运行它，
// 自己不再挂载。这样改完代码后只需刷新页面（或调 reload_page 工具）即可生效，
// 不必在 Tampermonkey 里重新安装。
//
// 只在 `npm run build:local` / `npm run dev:serve` 的本地构建里启用（VITE_DEV_UPDATE_URL 非空）；
// 生产构建该常量为空，整个函数直接返回 false，行为与以前完全一致。
//
// 关键点：
// - 用的还是同一个 Tampermonkey 脚本条目，GM 存储（登录 token、配置）不变，不需要重新登录。
// - 构建产物把 GM_* 和 Vue 当作外层作用域的自由变量引用。这里用 new Function 把它们作为参数
//   显式传进去，让新代码看到的是同一组 API。
// - 开发服务器不可达、超时或执行出错时返回 false，由已安装版本照常运行（不影响使用）。

declare const GM_addStyle: (css: string) => void
declare const GM_deleteValue: (key: string) => void
declare const GM_getValue: (key: string, def?: unknown) => unknown
declare const GM_listValues: () => string[]
declare const GM_notification: (opts: unknown) => void
declare const GM_setValue: (key: string, value: unknown) => void
declare const GM_xmlhttpRequest: (opts: {
  method: string
  url: string
  timeout?: number
  onload?: (r: { status: number; responseText: string }) => void
  onerror?: () => void
  ontimeout?: () => void
}) => void
declare const Vue: unknown

const DEV_UPDATE_URL: string = import.meta.env.VITE_DEV_UPDATE_URL || ''
const GUARD = '__AAH_DEV_LOADED__'

type GuardHost = { [GUARD]?: boolean }

/** 当前这份代码是不是开发加载器拉起来的「新版本」 */
export function isDevLoadedCopy(): boolean {
  return !!(globalThis as GuardHost)[GUARD]
}

function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      GM_xmlhttpRequest({
        method: 'GET',
        // 加时间戳绕过任何缓存
        url: `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`,
        timeout: timeoutMs,
        onload: (r) => resolve(r.status === 200 ? r.responseText : null),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * 尝试运行开发服务器上的最新构建。
 * @returns true = 已由新版本接管（调用方不要再挂载）；false = 照常运行当前版本
 */
export async function runLatestDevBuild(): Promise<boolean> {
  if (!DEV_UPDATE_URL || isDevLoadedCopy()) return false
  const text = await fetchText(DEV_UPDATE_URL, 1500)
  if (!text) return false
  const marker = '// ==/UserScript=='
  const at = text.indexOf(marker)
  const body = at >= 0 ? text.slice(at + marker.length) : text
  if (!body.trim()) return false
  try {
    ;(globalThis as GuardHost)[GUARD] = true
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function(
      'GM_addStyle', 'GM_deleteValue', 'GM_getValue', 'GM_listValues',
      'GM_notification', 'GM_setValue', 'GM_xmlhttpRequest', 'Vue',
      body,
    )
    run(
      GM_addStyle, GM_deleteValue, GM_getValue, GM_listValues,
      GM_notification, GM_setValue, GM_xmlhttpRequest, Vue,
    )
    return true
  } catch (e) {
    // 新代码执行失败：撤销标记，退回已安装版本，保证插件始终可用
    ;(globalThis as GuardHost)[GUARD] = false
    console.warn('[aah] 开发版加载失败，使用已安装版本', (e as Error).name || 'Error')
    return false
  }
}

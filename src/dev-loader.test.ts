import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { url: string; onload?: (r: { status: number; responseText: string }) => void; onerror?: () => void }
let respond: (req: Req) => void = () => {}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_DEV_UPDATE_URL', 'http://127.0.0.1:8017/x.user.js')
  const g = globalThis as Record<string, unknown>
  g.GM_xmlhttpRequest = (req: Req) => respond(req)
  for (const k of ['GM_addStyle', 'GM_deleteValue', 'GM_getValue', 'GM_listValues', 'GM_notification', 'GM_setValue']) {
    g[k] = vi.fn()
  }
  g.Vue = { tag: 'vue' }
  delete g.__AAH_DEV_LOADED__
  delete g.__ran
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const bundle = (code: string) => `// ==UserScript==\n// @version 9.9.9\n// ==/UserScript==\n${code}`

describe('dev auto-update loader', () => {
  it('runs the latest dev build with the same GM_* / Vue and tells the caller not to mount', async () => {
    respond = (req) => req.onload?.({ status: 200, responseText: bundle('globalThis.__ran = typeof GM_setValue + "/" + Vue.tag') })
    const { runLatestDevBuild, isDevLoadedCopy } = await import('./dev-loader')

    await expect(runLatestDevBuild()).resolves.toBe(true)
    expect((globalThis as Record<string, unknown>).__ran).toBe('function/vue')
    // 被拉起的新版本里再走一次 boot 时，不能再去拉一次（否则无限套娃）
    expect(isDevLoadedCopy()).toBe(true)
    await expect(runLatestDevBuild()).resolves.toBe(false)
  })

  it('falls back to the installed copy when the dev server is unreachable', async () => {
    respond = (req) => req.onerror?.()
    const { runLatestDevBuild, isDevLoadedCopy } = await import('./dev-loader')

    await expect(runLatestDevBuild()).resolves.toBe(false)
    expect(isDevLoadedCopy()).toBe(false)
  })

  it('falls back (and clears the guard) when the new build throws', async () => {
    respond = (req) => req.onload?.({ status: 200, responseText: bundle('throw new Error("boom")') })
    const { runLatestDevBuild, isDevLoadedCopy } = await import('./dev-loader')

    await expect(runLatestDevBuild()).resolves.toBe(false)
    expect(isDevLoadedCopy()).toBe(false)
  })

  it('is a no-op in production builds (no update URL)', async () => {
    vi.stubEnv('VITE_DEV_UPDATE_URL', '')
    const spy = vi.fn()
    respond = spy
    const { runLatestDevBuild } = await import('./dev-loader')

    await expect(runLatestDevBuild()).resolves.toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

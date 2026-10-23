// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BossRuntime, STORAGE_KEY } from '../src/runtime'
import type { PageExecution, PageInvocation } from '../src/contracts'

const API = 'https://gudaya.chat'
const ACCOUNT = `${API}|1`
const TOKEN = 'old-account-auth-token-long-value'
const popup = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' } as chrome.runtime.MessageSender
const page = { id: 'extension-id', frameId: 0, documentId: 'doc-1', url: 'https://www.zhipin.com/web/geek/chat', tab: { id: 12, url: 'https://www.zhipin.com/web/geek/chat' } } as chrome.runtime.MessageSender
const command = (id = 8, name = 'send_message', args: Record<string, unknown> = { text: 'message' }) => ({ id, action: 'tool.call', payload: { name, args } })
const heartbeat = (commands: unknown[]) => ({ command_epoch: 'db-outbox-v2', plugin_compatibility: { can_receive_commands: true }, commands })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(accounts: Record<string, unknown> = {}) {
  let disk: Record<string, unknown> = { [STORAGE_KEY]: {
    config: { apiBase: API, token: TOKEN, userId: 1, username: 'user-one', resumeId: 7, defaultResumeName: '', enabled: true, tabId: 12 }, accounts,
  } }
  let time = 1000
  let permission = true
  const accesses: unknown[] = []
  const calls: Array<{ path: string; body: Record<string, unknown>; token: string }> = []
  const pageCalls: PageInvocation[] = []
  const navigations: unknown[] = []
  let onPage: (invocation: PageInvocation, method: string) => Promise<unknown> = async () => ({ result: { ok: true, data: { delivery: 'delivered' } } })
  let onRequest: (path: string, body: Record<string, unknown>) => Promise<unknown> = async path => path.endsWith('/heartbeat') ? heartbeat([]) : { stored: true }
  const chromeMock = {
    runtime: { id: 'extension-id', getURL: (path: string) => `chrome-extension://extension-id/${path}`, getManifest: () => ({ version: '0.7.0' }) },
    storage: { local: {
      setAccessLevel: async (value: unknown) => { accesses.push(value) },
      get: async () => structuredClone(disk),
      set: async (value: Record<string, unknown>) => { disk = { ...disk, ...structuredClone(value) } },
    } },
    permissions: { contains: async () => permission },
    tabs: { get: async (id: number) => ({ id, url: 'https://www.zhipin.com/web/geek/chat' }), update: async (...args: unknown[]) => { navigations.push(args) }, reload: async (...args: unknown[]) => { navigations.push(args) } },
    scripting: { executeScript: async (details: { files?: string[]; args?: unknown[]; target: { tabId: number; documentIds: string[] } }) => {
      expect(details.target).toEqual({ tabId: 12, documentIds: ['doc-1'] })
      if (details.files || details.args?.length === 1) return []
      const invocation = details.args![2] as PageInvocation
      pageCalls.push(structuredClone(invocation))
      return [{ result: await onPage(invocation, String(details.args![1])) }]
    } },
  } as unknown as typeof chrome
  const fetchMock = (async (url: string | URL | Request, options: RequestInit) => {
    const path = new URL(String(url)).pathname
    const body = options.body ? JSON.parse(String(options.body)) : {}
    calls.push({ path, body, token: String((options.headers as Record<string, string>).Authorization || '') })
    const data = await onRequest(path, body)
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return {
    create: () => new BossRuntime({ chrome: chromeMock, fetch: fetchMock, now: () => time }),
    disk: () => disk[STORAGE_KEY] as { config: unknown; accounts: Record<string, { ack: number; receipts: Record<string, { state: string; result?: { error?: string }; uploaded: boolean }> }> },
    accesses, calls, pageCalls, navigations,
    advance: (milliseconds = 1000) => { time += milliseconds }, denyPermission: () => { permission = false },
    request: (handler: typeof onRequest) => { onRequest = handler }, page: (handler: typeof onPage) => { onPage = handler },
  }
}

describe('MV3 production message dispatcher persistence and trust', () => {
  it('retries a failed result upload after worker restart without repeating the page action or accounting effect', async () => {
    const h = harness()
    let failUpload = true
    h.request(async path => {
      if (path.endsWith('/heartbeat')) return heartbeat([command(8, 'apply_job', { jobId: 'job-1' })])
      if (path.endsWith('/greeting')) return { greeting: 'hello' }
      if (path.endsWith('/tools/result') && failUpload) { failUpload = false; throw new Error('offline') }
      return { stored: true, success: true }
    })
    h.page(async (_invocation, method) => method === 'prepare' ? { ok: true, data: { job: { platformJobId: 'job-1', title: 'role' } } } : ({ result: { ok: true, data: { delivery: 'delivered' } }, effects: [{ kind: 'application', payload: { platform: 'zhipin', platform_job_id: 'job-1', title: 'role', outcome: 'applied' } }] } satisfies PageExecution))
    await h.create().handle({ type: 'boss.tick', visibility: 'visible' }, page)
    expect(h.disk().accounts[ACCOUNT].ack).toBe(8)
    expect(h.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].uploaded).toBe(false)
    h.advance()
    await h.create().handle({ type: 'boss.tick', visibility: 'visible' }, page)
    expect(h.pageCalls.filter(call => call.context?.greeting)).toHaveLength(1)
    expect(h.calls.filter(call => call.path.endsWith('/record'))).toHaveLength(1)
    expect(h.calls.filter(call => call.path.endsWith('/record'))[0].body.resume_id).toBe(7)
    expect(h.calls.filter(call => call.path.endsWith('/tools/result'))).toHaveLength(2)
    expect(h.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].uploaded).toBe(true)
    expect(h.accesses).toContainEqual({ accessLevel: 'TRUSTED_CONTEXTS' })
    expect(JSON.stringify(h.pageCalls)).not.toContain(TOKEN)
  })

  it('turns a persisted started command into reconciliation evidence and leaves an unsupported legacy action unacknowledged', async () => {
    const h = harness({ [ACCOUNT]: { epoch: 'db-outbox-v2', ack: 0, receipts: {
      'db-outbox-v2:8': { commandId: 8, epoch: 'db-outbox-v2', tool: 'send_message', state: 'started', irreversible: true, uploaded: false, effects: [] },
    } } })
    h.request(async path => path.endsWith('/heartbeat') ? heartbeat([command(), { id: 9, action: 'orchestrator.start', payload: {} }, command(10)]) : { stored: true })
    const result = await h.create().handle({ type: 'boss.tick' }, page)
    expect(result).toMatchObject({ ok: true })
    expect(h.pageCalls).toHaveLength(0)
    expect(h.disk().accounts[ACCOUNT].ack).toBe(8)
    const upload = h.calls.find(call => call.path.endsWith('/tools/result'))!
    expect(upload.body).toMatchObject({ command_id: 8, ok: false, error: 'reconciliation_required', data: { retrySafe: false, mayHaveExecuted: true } })

    const stalled = harness({ [ACCOUNT]: { epoch: 'db-outbox-v2', ack: 8, receipts: {}, navigation: { tabId: 12, fromDocumentId: 'doc-1', startedAt: 0 } } })
    stalled.advance(31_000)
    stalled.request(async path => path.endsWith('/heartbeat') ? heartbeat([command(9, 'get_page_state', {}), command(10)]) : { stored: true })
    const stalledRuntime = stalled.create()
    await stalledRuntime.handle({ type: 'boss.tick' }, page)
    expect(stalled.pageCalls.map(call => call.name)).toEqual(['get_page_state'])
    expect(stalled.navigations).toHaveLength(0)
    expect(stalled.disk().accounts[ACCOUNT].ack).toBe(9)
    expect(await stalledRuntime.handle({ type: 'boss.status' }, popup)).toMatchObject({ phase: 'diagnostic_only', lastError: 'navigation_reenable_required' })
    await stalledRuntime.handle({ type: 'boss.enable', tabId: 12 }, popup)
    stalled.advance()
    await stalledRuntime.handle({ type: 'boss.tick' }, page)
    expect(stalled.pageCalls.map(call => call.name)).toEqual(['get_page_state', 'send_message'])
    expect(stalled.navigations).toHaveLength(0)
  })

  it('rejects forged page and popup senders and requires explicit host permission before accepting custom service credentials', async () => {
    const h = harness()
    const runtime = h.create()
    await expect(runtime.handle({ type: 'boss.logout' }, page)).rejects.toThrow('untrusted_sender')
    await expect(runtime.handle({ type: 'boss.tick' }, { ...page, id: 'other-extension' })).rejects.toThrow('untrusted_sender')
    await expect(runtime.handle({ type: 'boss.tick' }, { ...page, frameId: 3 })).rejects.toThrow('untrusted_sender')
    await expect(runtime.handle({ type: 'boss.tick' }, { ...page, url: 'https://www.zhipin.com.attacker.test/' })).rejects.toThrow('untrusted_sender')
    expect(await runtime.handle({ type: 'boss.tick' }, { ...page, tab: { id: 13, url: page.url } } as chrome.runtime.MessageSender)).toMatchObject({ ok: false })
    for (const apiBase of ['http://[::1]:8010', 'https://[::1]', 'http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'file:///etc/passwd', 'javascript:alert(1)']) {
      await expect(runtime.handle({ type: 'boss.token', apiBase, token: TOKEN }, popup)).rejects.toThrow('invalid_api_origin')
    }
    h.denyPermission()
    await expect(runtime.handle({ type: 'boss.token', apiBase: 'http://127.0.0.1:8010', token: TOKEN }, popup)).rejects.toThrow('api_permission_required')
    expect(h.calls).toHaveLength(0)

    // MAIN-world page output cannot grant a read tool write access, smuggle API fields, or navigate arbitrary BOSS paths.
    const attacks = [
      { name: 'get_page_state', args: {}, effects: [{ kind: 'application', payload: { platform: 'zhipin', platform_job_id: 'fake', title: 'fake', outcome: 'applied' } }] },
      { name: 'send_message', args: { text: 'hello' }, effects: [{ kind: 'conversation_deleted', payload: { platform: 'zhipin', company: 'fake' } }] },
      { name: 'delete_thread', args: { company: 'company' }, effects: [{ kind: 'conversation_deleted', payload: { platform: 'zhipin', company: 'company', token: 'should-never-reach-api' } }] },
      { name: 'open_search', args: { keyword: 'keyword' }, effects: [{ kind: 'navigate', url: 'https://www.zhipin.com/web/geek/settings' }] },
      { name: 'open_thread', args: { company: 'company' }, effects: [{ kind: 'navigate', url: 'https://attacker.test/', pendingThread: { company: 'company', jobTitle: '' } }] },
      { name: 'reload_page', args: {}, effects: [{ kind: 'reload' }, { kind: 'reload' }] },
      { name: 'get_page_state', args: {}, effects: { kind: 'application' } },
      { name: 'apply_job', args: { jobId: 'job-1' }, effects: [{ kind: 'application', payload: { platform: 'zhipin', platform_job_id: 'job-1', title: 'role', outcome: 'applied', resume_id: 99 } }] },
    ]
    for (const attack of attacks) {
      const malicious = harness()
      malicious.request(async path => path.endsWith('/heartbeat') ? heartbeat([command(8, attack.name, attack.args)]) : path.endsWith('/greeting') ? { greeting: 'hello' } : { stored: true })
      malicious.page(async (_invocation, method) => method === 'prepare' ? { ok: true, data: { job: { platformJobId: 'job-1', title: 'role' } } } : { result: { ok: true }, effects: attack.effects })
      await malicious.create().handle({ type: 'boss.tick' }, page)
      expect(malicious.calls.filter(call => call.path.endsWith('/record') || call.path.endsWith('/mark-deleted'))).toHaveLength(0)
      expect(malicious.navigations).toHaveLength(0)
      expect(malicious.calls.find(call => call.path.endsWith('/tools/result'))?.body).toMatchObject({ ok: false, error: 'reconciliation_required', data: { reason: 'invalid_page_effect', retrySafe: false } })
    }
    const malformed = harness()
    malformed.request(async path => path.endsWith('/heartbeat') ? heartbeat([{ ...command(8, 'get_page_state'), payload: { name: 'get_page_state', args: [] } }]) : { stored: true })
    await malformed.create().handle({ type: 'boss.tick' }, page)
    expect(malformed.pageCalls).toHaveLength(0)
    expect(malformed.calls.find(call => call.path.endsWith('/tools/result'))?.body).toMatchObject({ ok: false, error: 'invalid_arguments' })
  })

  it('invalidates an in-flight apply preparation on logout and never uploads its old-account receipt to a new account', async () => {
    const h = harness()
    const greeting = deferred<unknown>()
    const requested = deferred<void>()
    h.request(async path => {
      if (path.endsWith('/heartbeat')) return heartbeat([command(8, 'apply_job', { jobId: 'job-1' })])
      if (path.endsWith('/greeting')) { requested.resolve(); return greeting.promise }
      if (path.endsWith('/auth/token')) return { token: 'new-account-auth-token-long-value', user_id: 2, username: 'user-two' }
      if (path.endsWith('/config')) return { resumes: [] }
      return { stored: true }
    })
    h.page(async (_invocation, method) => method === 'prepare' ? { ok: true, data: { job: { platformJobId: 'job-1', title: 'role' } } } : { result: { ok: true } })
    const runtime = h.create()
    const tick = runtime.handle({ type: 'boss.tick' }, page)
    await requested.promise
    const logout = runtime.handle({ type: 'boss.logout' }, popup)
    greeting.resolve({ greeting: 'hello' })
    await Promise.all([tick, logout])
    expect(h.pageCalls.filter(call => call.context?.greeting)).toHaveLength(0)
    expect(h.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].result?.error).toBe('reconciliation_required')
    await runtime.handle({ type: 'boss.token', apiBase: API, token: 'new-account-auth-token-long-value' }, popup)
    await runtime.handle({ type: 'boss.enable', tabId: 12 }, popup)
    h.advance()
    h.request(async path => path.endsWith('/heartbeat') ? heartbeat([]) : { stored: true })
    await runtime.handle({ type: 'boss.tick' }, page)
    expect(h.calls.filter(call => call.path.endsWith('/tools/result'))).toHaveLength(0)
    expect(h.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].uploaded).toBe(false)
  })
})

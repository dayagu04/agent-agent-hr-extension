// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BossHeartbeatScheduler, RECOVERY_ALARM } from '../src/background-scheduler'
import { BossContentHeartbeat } from '../src/runtime-content'
import { BossRuntime, STORAGE_KEY } from '../src/runtime'
import { PAGE_RUNTIME_KEY, type PageExecution, type PageInvocation } from '../src/contracts'

const API = 'https://gudaya.chat'
const ACCOUNT = `${API}|1`
const TOKEN = 'old-account-auth-token-long-value'
const popup = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' } as chrome.runtime.MessageSender
const page = { id: 'extension-id', frameId: 0, documentLifecycle: 'active', documentId: 'doc-1', url: 'https://www.zhipin.com/web/geek/chat', tab: { id: 12, url: 'https://www.zhipin.com/web/geek/chat' } } as chrome.runtime.MessageSender
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
  const cancellations: unknown[][] = []
  let epoch = 0
  let beforeInvocation: () => Promise<void> = async () => undefined
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
    scripting: { executeScript: async (details: { files?: string[]; args?: unknown[]; func?: (...args: unknown[]) => unknown; target: { tabId: number; documentIds: string[] } }) => {
      expect(details.target).toEqual({ tabId: 12, documentIds: ['doc-1'] })
      if (details.files) return []
      if (details.args?.length === 2) { cancellations.push(details.args); return [] }
      if ((details.args?.length ?? 0) > 2) await beforeInvocation()
      const invoke = async (invocation: PageInvocation, method: string) => {
        pageCalls.push(structuredClone(invocation))
        return onPage(invocation, method)
      }
      const globals = globalThis as unknown as Record<string, unknown>
      const previous = globals[PAGE_RUNTIME_KEY]
      globals[PAGE_RUNTIME_KEY] = { lifecycleEpoch: () => epoch, run: (invocation: PageInvocation) => invoke(invocation, 'run'), prepare: (invocation: PageInvocation) => invoke(invocation, 'prepare') }
      let result: unknown
      try { result = details.func!(...(details.args || [])) }
      finally { if (previous === undefined) delete globals[PAGE_RUNTIME_KEY]; else globals[PAGE_RUNTIME_KEY] = previous }
      return [{ result: await result }]
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
    chrome: chromeMock,
    create: () => new BossRuntime({ chrome: chromeMock, fetch: fetchMock, now: () => time }),
    disk: () => disk[STORAGE_KEY] as { config: unknown; accounts: Record<string, { ack: number; receipts: Record<string, { state: string; result?: { error?: string }; uploaded: boolean }> }> },
    accesses, calls, pageCalls, navigations, cancellations,
    advance: (milliseconds = 1000) => { time += milliseconds }, denyPermission: () => { permission = false },
    changeEpoch: () => { epoch += 1 }, beforeInvocation: (handler: typeof beforeInvocation) => { beforeInvocation = handler },
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
    await expect(runtime.handle({ type: 'boss.tick' }, { ...page, documentLifecycle: 'cached' })).rejects.toThrow('untrusted_sender')
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

  it('drives actual hidden-page heartbeats through the production scheduler, stops on freeze/timeout, and fences a late session wake', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const runtime = h.create()
      const wakes: Array<{ generation: string; options: unknown }> = []
      const alarms: unknown[] = []
      let held = false
      const pendingWake = deferred<unknown>()
      let content!: BossContentHeartbeat
      const scheduler = new BossHeartbeatScheduler({
        target: () => runtime.schedulerTarget(),
        chrome: {
          tabs: { ...h.chrome.tabs, sendMessage: async (_tab: number, request: { generation: string }, options: unknown) => {
            wakes.push({ generation: request.generation, options })
            return held ? pendingWake.promise : content.wake(request, { id: 'extension-id' })
          } },
          alarms: { get: async () => undefined, create: async (...args: unknown[]) => { alarms.push(args) }, clear: async () => true, onAlarm: { addListener: () => undefined } },
        } as unknown as Pick<typeof chrome, 'tabs' | 'alarms'>,
      })
      content = new BossContentHeartbeat({
        visibility: () => 'hidden',
        runtime: { id: 'extension-id', sendMessage: async (message: { type: string; wakeGeneration?: string }) => {
          const response = await runtime.handle(message, page)
          await scheduler.refresh(message.type === 'boss.tick' ? { tabId: 12, documentId: 'doc-1', ...(message.wakeGeneration === undefined ? {} : { generation: message.wakeGeneration }) } : undefined)
          return response
        } } as unknown as Pick<typeof chrome.runtime, 'id' | 'sendMessage'>,
      })
      await scheduler.start()
      await content.resume() // Native active-document proof; no test-side synthetic scheduler heartbeat.
      const heartbeats = () => h.calls.filter(call => call.path.endsWith('/heartbeat'))
      expect(heartbeats()).toHaveLength(1)
      expect(alarms).toContainEqual([RECOVERY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 }])
      h.advance(2000)
      await vi.advanceTimersByTimeAsync(2000)
      expect(heartbeats()).toHaveLength(2)
      expect(heartbeats()[1].body.visibility).toBe('hidden')
      expect(wakes[0].options).toEqual({ documentId: 'doc-1' })

      await content.freeze()
      h.advance(60_000)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(heartbeats()).toHaveLength(2)
      await scheduler.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(heartbeats()).toHaveLength(2)
      expect(wakes.at(-1)?.options).toEqual({ frameId: 0 })
      expect((await runtime.schedulerTarget()).documentId).toBeNull()

      await content.resume()
      expect(heartbeats()).toHaveLength(3)
      held = true
      h.advance(2000)
      await vi.advanceTimersByTimeAsync(2000)
      const oldGeneration = wakes.at(-1)!.generation
      const wakeCount = wakes.length
      await vi.advanceTimersByTimeAsync(5000)
      await scheduler.recover()
      await scheduler.recover()
      expect(wakes).toHaveLength(wakeCount) // A frozen sendMessage cannot accumulate one pending message per alarm.
      expect(heartbeats()).toHaveLength(3)

      await runtime.handle({ type: 'boss.disable' }, popup)
      await scheduler.refresh()
      pendingWake.resolve({ runnable: true, generation: oldGeneration })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(wakes).toHaveLength(wakeCount)
      await runtime.handle({ type: 'boss.enable', tabId: 12 }, popup)
      await scheduler.refresh()
      await content.wake({ type: 'boss.wake', generation: oldGeneration }, { id: 'extension-id' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(heartbeats()).toHaveLength(3)
      expect(wakes).toHaveLength(wakeCount)

      held = false
      await content.resume()
      h.advance(2000)
      await vi.advanceTimersByTimeAsync(2000)
      expect(heartbeats()).toHaveLength(5)
      expect(wakes.at(-1)?.generation).not.toBe(oldGeneration)

      // MAIN may remain suspended after freeze. Its old Promise must not hold logout in the command queue.
      const frozen = harness()
      const mainStarted = deferred<void>()
      const mainResult = deferred<unknown>()
      frozen.request(async path => path.endsWith('/heartbeat') ? heartbeat([command()]) : { stored: true })
      frozen.page(async () => { mainStarted.resolve(); return mainResult.promise })
      const frozenRuntime = frozen.create()
      const frozenContent = new BossContentHeartbeat({ visibility: () => 'hidden', runtime: {
        id: 'extension-id', sendMessage: (message: unknown) => frozenRuntime.handle(message, page),
      } as unknown as Pick<typeof chrome.runtime, 'id' | 'sendMessage'> })
      const running = frozenContent.resume()
      await mainStarted.promise
      const beforeFreeze = await frozenRuntime.schedulerTarget()
      await frozenContent.freeze()
      await running // Resolves through the production interrupt race while mainResult is still pending.
      expect((await frozenRuntime.schedulerTarget()).generation).not.toBe(beforeFreeze.generation)
      expect(await frozenRuntime.handle({ type: 'boss.tick', lifecycleVersion: 0 }, page)).toMatchObject({ phase: 'page_frozen' })
      await frozenRuntime.handle({ type: 'boss.logout' }, popup)
      expect(frozen.disk().config).toBeNull()
      expect(frozen.cancellations[0]?.[1]).toMatch(/^boss:[0-9a-f]{64}$/)
      expect(frozen.disk().accounts[ACCOUNT].receipts['db-outbox-v2:8'].result?.error).toBe('reconciliation_required')
      mainResult.resolve({ result: { ok: true, data: { delivery: 'delivered' } } })
      await vi.advanceTimersByTimeAsync(0)
      expect(frozen.calls.filter(call => call.path.endsWith('/tools/result'))).toHaveLength(0)

      // The invocation deadline also fences a preparation that returns late, before any MAIN run existed to cancel.
      const late = harness()
      const lookupStarted = deferred<void>()
      const tabLookup = deferred<chrome.tabs.Tab>()
      late.chrome.tabs.get = (() => { lookupStarted.resolve(); return tabLookup.promise }) as typeof chrome.tabs.get
      late.request(async path => path.endsWith('/heartbeat') ? heartbeat([command()]) : { stored: true })
      const lateTick = late.create().handle({ type: 'boss.tick' }, page)
      await lookupStarted.promise
      await vi.advanceTimersByTimeAsync(180_000)
      await lateTick
      expect(late.calls.find(call => call.path.endsWith('/tools/result'))?.body).toMatchObject({ error: 'reconciliation_required' })
      tabLookup.resolve({ id: 12, url: page.url } as chrome.tabs.Tab)
      await vi.advanceTimersByTimeAsync(0)
      expect(late.pageCalls).toHaveLength(0)

      // Execute the actual serialized MAIN gate after Chrome queues it: epoch changes and expiry must reject late starts.
      for (const interruption of ['freeze-and-logout', 'deadline']) {
        const queued = harness()
        const invocationQueued = deferred<void>()
        const dispatch = deferred<void>()
        queued.beforeInvocation(async () => { invocationQueued.resolve(); await dispatch.promise })
        queued.request(async path => path.endsWith('/heartbeat') ? heartbeat([command()]) : { stored: true })
        const queuedRuntime = queued.create()
        const queuedTick = queuedRuntime.handle({ type: 'boss.tick', lifecycleVersion: 0 }, page)
        await invocationQueued.promise // Preflight already read the epoch; the real run function has not started.
        if (interruption === 'freeze-and-logout') {
          queued.changeEpoch() // MAIN's native freeze listener increments its epoch before cancelling leases.
          await queuedRuntime.handle({ type: 'boss.lifecycle', state: 'frozen', lifecycleVersion: 1 }, page)
          await queuedTick
          await queuedRuntime.handle({ type: 'boss.logout' }, popup)
        } else {
          await vi.advanceTimersByTimeAsync(180_000)
          await queuedTick
        }
        dispatch.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(queued.pageCalls).toHaveLength(0)
      }

      // A late alarm create is serialized before disable.clear, and a failed create is retryable in the same state.
      const alarmTarget = { enabled: true, tabId: 12, documentId: 'doc-1', generation: 'alarm-enable' }
      const createStarted = deferred<void>()
      const createFinished = deferred<void>()
      const alarmOrder: string[] = []
      const serialized = new BossHeartbeatScheduler({ target: async () => alarmTarget, chrome: {
        tabs: { sendMessage: async () => ({ runnable: false }) },
        alarms: {
          get: async () => undefined,
          create: async () => { alarmOrder.push('create'); createStarted.resolve(); await createFinished.promise; alarmOrder.push('created') },
          clear: async () => { alarmOrder.push('clear'); return true }, onAlarm: { addListener: () => undefined },
        },
      } as unknown as Pick<typeof chrome, 'tabs' | 'alarms'> })
      const starting = serialized.start()
      await createStarted.promise
      alarmTarget.enabled = false
      alarmTarget.generation = 'alarm-disable'
      const disabling = serialized.refresh()
      createFinished.resolve()
      await Promise.all([starting, disabling])
      expect(alarmOrder).toEqual(['create', 'created', 'clear'])
      let creates = 0
      const retrying = new BossHeartbeatScheduler({ target: async () => ({ ...alarmTarget, enabled: true }), chrome: {
        tabs: { sendMessage: async () => ({ runnable: false }) },
        alarms: { get: async () => undefined, create: async () => { creates += 1; if (creates === 1) throw new Error('alarm-unavailable') }, clear: async () => true, onAlarm: { addListener: () => undefined } },
      } as unknown as Pick<typeof chrome, 'tabs' | 'alarms'> })
      await expect(retrying.refresh()).rejects.toThrow('alarm-unavailable')
      await retrying.refresh()
      expect(creates).toBe(2)
    } finally { vi.useRealTimers() }
  })

})

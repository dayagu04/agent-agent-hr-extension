import { PAGE_RUNTIME_KEY, type PageEffect, type PageExecution, type PageInvocation, type ToolResult } from './contracts'
import { TOOL_CATALOG, validateToolArgs } from './tools-contract'

export const STORAGE_KEY = 'boss-agent.runtime.v1'
export const DEFAULT_API_BASE = 'https://gudaya.chat'
const API_PATHS = new Set(['/api/auth/login', '/api/auth/token', '/api/plugin/config', '/api/plugin/heartbeat', '/api/plugin/greeting', '/api/plugin/record', '/api/plugin/chat/mark-deleted', '/api/plugin/tools/result'])
const BOSS_ORIGIN = 'https://www.zhipin.com'
const MAX_PENDING = 20
const MAX_RESULT_BYTES = 200_000
const MAX_STATE_BYTES = 7_000_000
const PAGE_TIMEOUT_MS = 180_000
const DIAGNOSTIC_TOOLS = new Set(['open_thread', 'get_page_state', 'scan_jobs', 'read_job_detail', 'read_filters', 'list_threads', 'read_messages', 'list_pending_cards', 'read_thread_header', 'probe_overlays', 'probe_dom', 'probe_row', 'list_tools'])

interface Config {
  apiBase: string
  token: string
  userId: number
  username: string
  resumeId: number | null
  defaultResumeName: string
  enabled: boolean
  tabId: number | null
}
interface EffectReceipt { effect: PageEffect; done: boolean; started?: boolean }
interface Receipt {
  commandId: number
  epoch: string
  tool: string
  state: 'started' | 'done'
  irreversible: boolean
  result?: ToolResult
  uploaded: boolean
  effects: EffectReceipt[]
  document?: { tabId: number; documentId: string }
}
interface AccountState {
  epoch: string
  ack: number
  receipts: Record<string, Receipt>
  pendingThread?: { company: string; jobTitle: string; fromDocumentId: string; commandId?: number; epoch?: string; attempts?: number }
  navigation?: { tabId: number; fromDocumentId: string; startedAt: number }
  diagnosticOnly?: boolean
}
interface State { config: Config | null; accounts: Record<string, AccountState> }
export interface RuntimeDependencies {
  chrome: typeof chrome
  fetch: typeof fetch
  now?: () => number
}
interface PageConnection { tabId: number; documentId: string; visibility: string; seenAt: number }
interface Session { accountKey: string; config: Config; revision: number }
export interface SchedulerTarget { enabled: boolean; tabId: number | null; documentId: string | null; generation: string }
interface RemoteCommand { id: number; action: string; payload?: Record<string, unknown> }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function fail(error: string): ToolResult { return { ok: false, error } }
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}
export function normalizeApiBase(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_api_origin')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('invalid_api_origin') }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.hostname === '[::1]' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('invalid_api_origin')
  return url.origin
}
export function apiPermissionPattern(apiBase: string): string {
  const url = new URL(normalizeApiBase(apiBase))
  return `${url.protocol}//${url.hostname}/*`
}
async function pageCommandKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return `boss:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
function bossUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try { const url = new URL(value); return url.origin === BOSS_ORIGIN && !url.username && !url.password } catch { return false }
}
function accountKey(config: Config): string { return `${config.apiBase}|${config.userId}` }
function receiptKey(epoch: string, commandId: number): string { return `${epoch}:${commandId}` }

function strictObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('invalid_page_effect')
  return value as Record<string, unknown>
}
function keysOnly(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid_page_effect')
}
function field(value: unknown, maxLength: number, required = false): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length > maxLength || (required && !value.trim())) throw new Error('invalid_page_effect')
  return value
}
/** MAIN-world output is untrusted. Only the requested tool can emit its own narrowly typed effect. */
function pageEffects(tool: string, raw: unknown, resumeId: number | null, persisted = false): PageEffect[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 1) throw new Error('invalid_page_effect')
  return raw.map(value => {
    const effect = strictObject(value)
    if (tool === 'apply_job' && effect.kind === 'application') {
      keysOnly(effect, ['kind', 'payload'])
      const payload = strictObject(effect.payload)
      keysOnly(payload, ['platform', 'platform_job_id', 'title', 'company', 'city', 'url', 'salary', 'match_score', 'outcome', 'error', 'greeting_sent', 'run_id', 'keyword', ...(persisted ? ['resume_id'] : [])])
      if (payload.platform !== 'zhipin' || typeof payload.outcome !== 'string' || !['applied', 'unknown', 'failed'].includes(payload.outcome) ||
          (payload.greeting_sent !== undefined && typeof payload.greeting_sent !== 'boolean') ||
          (payload.match_score !== undefined && (typeof payload.match_score !== 'number' || !Number.isFinite(payload.match_score) || payload.match_score < 0 || payload.match_score > 100)) ||
          (payload.run_id !== undefined && payload.run_id !== null)) throw new Error('invalid_page_effect')
      const id = persisted ? number(payload.resume_id) : number(resumeId)
      if (!id) throw new Error('invalid_page_effect')
      const url = field(payload.url, 2048)
      if (url && !bossUrl(url)) throw new Error('invalid_page_effect')
      return { kind: 'application', payload: {
        platform: 'zhipin', platform_job_id: field(payload.platform_job_id, 512, true), title: field(payload.title, 255, true),
        company: field(payload.company, 255), city: field(payload.city, 255), url, salary: field(payload.salary, 128),
        match_score: payload.match_score ?? 0, outcome: payload.outcome, error: field(payload.error, 1000),
        greeting_sent: payload.greeting_sent ?? false, run_id: null, keyword: field(payload.keyword, 512), resume_id: id,
      } }
    }
    if (tool === 'delete_thread' && effect.kind === 'conversation_deleted') {
      keysOnly(effect, ['kind', 'payload'])
      const payload = strictObject(effect.payload)
      keysOnly(payload, ['platform', 'company', 'job_title', 'reason', 'encrypt_job_id'])
      if (payload.platform !== 'zhipin') throw new Error('invalid_page_effect')
      return { kind: 'conversation_deleted', payload: {
        platform: 'zhipin', company: field(payload.company, 255, true), job_title: field(payload.job_title, 255),
        reason: field(payload.reason, 64) || 'manual', encrypt_job_id: field(payload.encrypt_job_id, 512),
      } }
    }
    if ((tool === 'open_search' || tool === 'open_thread') && effect.kind === 'navigate') {
      keysOnly(effect, ['kind', 'url', ...(tool === 'open_thread' ? ['pendingThread'] : [])])
      const url = field(effect.url, 4096, true)
      if (!bossUrl(url)) throw new Error('invalid_page_effect')
      const parsed = new URL(url)
      if (parsed.hash || parsed.pathname !== (tool === 'open_search' ? '/web/geek/jobs' : '/web/geek/chat') || (tool === 'open_thread' && parsed.search)) throw new Error('invalid_page_effect')
      if (tool === 'open_thread') {
        const thread = strictObject(effect.pendingThread)
        keysOnly(thread, ['company', 'jobTitle'])
        return { kind: 'navigate', url, pendingThread: { company: field(thread.company, 255, true), jobTitle: field(thread.jobTitle, 255) } }
      }
      return { kind: 'navigate', url }
    }
    if (tool === 'reload_page' && effect.kind === 'reload') {
      keysOnly(effect, ['kind'])
      return { kind: 'reload' }
    }
    throw new Error('invalid_page_effect')
  })
}


/** Production message dispatcher. All state writes and remote commands share one queue. */
export class BossRuntime {
  private readonly api: typeof chrome
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private state: State = { config: null, accounts: {} }
  private loaded: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private revision = 0
  private readonly schedulerEpoch = crypto.randomUUID()
  private requestController: AbortController | null = null
  private cancellation: Promise<void> = Promise.resolve()
  private activePageCall: { connection: PageConnection; key: string; controller: AbortController } | null = null
  private pageLifecycle = new Map<string, { version: number; frozen: boolean }>()
  private connection: PageConnection | null = null
  private pageReady = ''
  private ticking = false
  private lastTick = 0
  private phase = 'disabled'
  private lastError = ''

  constructor(dependencies: RuntimeDependencies) {
    this.api = dependencies.chrome
    this.fetcher = dependencies.fetch
    this.now = dependencies.now || Date.now
    this.loaded = this.load()
  }
  private async load(): Promise<void> {
    // Content scripts cannot read JWTs or any persisted tool output.
    await this.api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    const saved = (await this.api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as State | undefined
    if (saved && typeof saved === 'object' && saved.accounts) this.state = saved
    // A restarted worker has no proof whether a started page action completed. Never replay it.
    for (const [namespace, account] of Object.entries(this.state.accounts)) {
      for (const receipt of Object.values(account.receipts)) {
        if (receipt.state === 'started') {
          if (receipt.document) await this.cancelPage(receipt.document, await pageCommandKey(`${namespace}|${receiptKey(receipt.epoch, receipt.commandId)}`))
          receipt.state = 'done'
          receipt.result = this.reconciliation(receipt.tool)
          receipt.uploaded = false
        }
      }
    }
    await this.save()
    this.phase = this.state.config?.enabled ? 'awaiting_boss_page' : 'disabled'
  }
  private save(): Promise<void> { return this.api.storage.local.set({ [STORAGE_KEY]: this.state }) }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => { await this.loaded; return run() })
    this.queue = next.catch(() => undefined)
    return next
  }
  private trustedPopup(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === this.api.runtime.id && !sender.tab && sender.url === this.api.runtime.getURL('popup.html')
  }
  private trustedPage(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === this.api.runtime.id && sender.frameId === 0 && (!sender.documentLifecycle || sender.documentLifecycle === 'active') && number(sender.tab?.id) !== null &&
      typeof sender.documentId === 'string' && !!sender.documentId && bossUrl(sender.url) && bossUrl(sender.tab?.url)
  }
  /** Controls invalidate an in-flight session immediately, before waiting for its queue. */
  async handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const payload = object(message)
    if (payload.type === 'boss.lifecycle') {
      if (!this.trustedPage(sender)) throw new Error('untrusted_sender')
      await this.loaded
      if (payload.state !== 'frozen' || !this.state.config?.enabled || this.state.config.tabId !== sender.tab!.id || (this.connection && this.connection.documentId !== sender.documentId)) return { ok: false }
      const version = payload.lifecycleVersion
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return { ok: false }
      const documentKey = `${sender.tab!.id}:${sender.documentId}`
      if ((this.pageLifecycle.get(documentKey)?.version ?? -1) > version) return { ok: false }
      this.pageLifecycle.set(documentKey, { version, frozen: true })
      this.interrupt() // Invalidate the session and cancel the captured MAIN lease before dropping the document proof.
      this.connection = null
      this.phase = 'page_frozen'
      return { ok: true }
    }
    if (payload.type === 'boss.tick') {
      if (!this.trustedPage(sender)) throw new Error('untrusted_sender')
      if (this.ticking) return { ok: true, phase: this.phase }
      this.ticking = true
      try { return await this.enqueue(() => this.tick(payload, sender)) } finally { this.ticking = false }
    }
    if (!this.trustedPopup(sender)) throw new Error('untrusted_sender')
    if (payload.type === 'boss.status') { await this.loaded; return this.status() }
    if (['boss.login', 'boss.token', 'boss.logout', 'boss.enable', 'boss.disable', 'boss.resume'].includes(String(payload.type))) {
      this.interrupt()
    }
    return this.enqueue(async () => {
      if (['boss.login', 'boss.token', 'boss.logout', 'boss.enable', 'boss.disable', 'boss.resume'].includes(String(payload.type))) {
        await this.cancellation
        this.cancelDeferredActions()
      }
      if (['boss.login', 'boss.token', 'boss.logout', 'boss.disable', 'boss.enable'].includes(String(payload.type)) && this.state.config) {
        this.state.config.enabled = false
        await this.save()
      }
      switch (payload.type) {
        case 'boss.status': return this.status()
        case 'boss.login': return this.authenticate(payload, false)
        case 'boss.token': return this.authenticate(payload, true)
        case 'boss.logout': this.state.config = null; this.connection = null; this.phase = 'signed_out'; await this.save(); return this.status()
        case 'boss.disable': {
          if (this.state.config) this.state.config.enabled = false
          this.phase = 'disabled'; await this.save(); return this.status()
        }
        case 'boss.enable': return this.enable(payload.tabId)
        case 'boss.resume': {
          const cfg = this.requireConfig()
          cfg.resumeId = number(payload.resumeId)
          cfg.defaultResumeName = typeof payload.defaultResumeName === 'string' ? payload.defaultResumeName.trim().slice(0, 200) : ''
          await this.save(); return this.status()
        }
        case 'boss.refresh': return this.refreshConfig()
        default: throw new Error('unknown_message')
      }
    })
  }
  async schedulerTarget(): Promise<SchedulerTarget> {
    await this.loaded
    const config = this.state.config
    return { enabled: !!config?.enabled, tabId: config?.tabId ?? null, documentId: this.connection?.documentId ?? null, generation: `${this.schedulerEpoch}:${this.revision}` }
  }
  private interrupt(): void {
    this.revision += 1
    this.requestController?.abort()
    const active = this.activePageCall
    if (active) {
      this.cancellation = this.cancelPage(active.connection, active.key)
      active.controller.abort() // Release the serial command queue even when MAIN is suspended by page freeze.
    }
  }
  private cancelDeferredActions(): void {
    if (!this.state.config) return
    const account = this.state.accounts[accountKey(this.state.config)]
    if (!account) return
    account.pendingThread = undefined
    account.navigation = undefined
    for (const receipt of Object.values(account.receipts)) {
      for (const item of receipt.effects) {
        if (!item.done && (item.effect.kind === 'navigate' || item.effect.kind === 'reload')) {
          item.done = true
          if (!receipt.uploaded) receipt.result = this.reconciliation(receipt.tool)
        }
      }
    }
  }
  private async cancelPage(connection: { tabId: number; documentId: string }, commandKey: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancellation = this.api.scripting.executeScript({
      target: { tabId: connection.tabId, documentIds: [connection.documentId] }, world: 'MAIN',
      func: (key: string, command: string) => {
        const runtime = (globalThis as unknown as Record<string, { cancel?: (commandKey?: string) => void }>)[key]
        runtime?.cancel?.(command)
      }, args: [PAGE_RUNTIME_KEY, commandKey],
    }).catch(() => undefined)
    try { await Promise.race([cancellation, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000) })]) }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
  private requireConfig(): Config {
    if (!this.state.config?.token) throw new Error('login_required')
    return this.state.config
  }
  private session(): Session {
    const config = { ...this.requireConfig() }
    return { accountKey: accountKey(config), config, revision: this.revision }
  }
  private active(session: Session): boolean {
    return this.revision === session.revision && !!this.state.config && accountKey(this.state.config) === session.accountKey && this.state.config.token === session.config.token
  }
  private assertActive(session: Session): void { if (!this.active(session)) throw new Error('session_changed') }
  private account(session: Session): AccountState {
    return this.state.accounts[session.accountKey] ||= { epoch: '', ack: 0, receipts: {} }
  }
  private async permission(apiBase: string): Promise<void> {
    if (apiBase !== DEFAULT_API_BASE && !await this.api.permissions.contains({ origins: [apiPermissionPattern(apiBase)] })) throw new Error('api_permission_required')
  }
  private async request(config: Pick<Config, 'apiBase' | 'token'>, path: string, body?: unknown, session?: Session): Promise<Record<string, unknown>> {
    if (!API_PATHS.has(path)) throw new Error('api_path_forbidden')
    if (session) this.assertActive(session)
    await this.permission(config.apiBase)
    if (session) this.assertActive(session)
    const controller = new AbortController()
    this.requestController = controller
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await this.fetcher(`${config.apiBase}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: {
          'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      })
      if (session) this.assertActive(session)
      if (!response.ok) throw new Error(`api_http_${response.status}`)
      return object(await response.json())
    } finally {
      clearTimeout(timeout)
      if (this.requestController === controller) this.requestController = null
    }
  }
  private async authenticate(payload: Record<string, unknown>, useToken: boolean): Promise<unknown> {
    const apiBase = normalizeApiBase(payload.apiBase || DEFAULT_API_BASE)
    const revision = this.revision
    await this.permission(apiBase)
    const response = useToken
      ? await this.request({ apiBase, token: this.validateToken(payload.token) }, '/api/auth/token')
      : await this.request({ apiBase, token: '' }, '/api/auth/login', {
        email: typeof payload.email === 'string' ? payload.email.trim() : '',
        password: typeof payload.password === 'string' ? payload.password : '',
      })
    if (revision !== this.revision) throw new Error('session_changed')
    const token = this.validateToken(response.token)
    const userId = number(response.user_id)
    if (!userId) throw new Error('invalid_auth_response')
    this.state.config = { apiBase, token, userId, username: String(response.username || ''), resumeId: null, defaultResumeName: '', enabled: false, tabId: null }
    this.connection = null
    this.pageReady = ''
    this.phase = 'disabled'
    this.lastError = ''
    await this.save()
    return this.refreshConfig()
  }
  private validateToken(token: unknown): string {
    if (typeof token !== 'string' || token.length < 20 || token.length > 8192 || /\s/.test(token)) throw new Error('invalid_token')
    return token
  }
  private async refreshConfig(): Promise<unknown> {
    const session = this.session()
    const data = await this.request(session.config, '/api/plugin/config', undefined, session)
    const resumes = Array.isArray(data.resumes) ? data.resumes.map(object).filter(item => number(item.id)).map(item => ({ id: item.id, name: String(item.name || '') })) : []
    const preferences = object(data.plugin_preferences)
    const preferred = number(preferences.default_send_resume_id)
    if (!session.config.resumeId && preferred && resumes.some(item => item.id === preferred)) this.requireConfig().resumeId = preferred
    await this.save()
    return { ...(this.status() as object), resumes }
  }
  private async enable(tabId: unknown): Promise<unknown> {
    const config = this.requireConfig()
    const id = number(tabId)
    if (!id) throw new Error('boss_tab_required')
    const tab = await this.api.tabs.get(id)
    if (!bossUrl(tab.url)) throw new Error('boss_tab_required')
    config.enabled = true
    const account = this.state.accounts[accountKey(config)]
    if (account) account.diagnosticOnly = false
    config.tabId = id
    this.connection = null
    this.pageReady = ''
    this.phase = 'awaiting_boss_page'
    this.lastError = ''
    await this.save()
    return this.status()
  }
  private status(): unknown {
    const config = this.state.config
    const account = config ? this.state.accounts[accountKey(config)] : undefined
    const online = !!this.connection && this.now() - this.connection.seenAt < 10_000
    return {
      authenticated: !!config, apiBase: config?.apiBase || DEFAULT_API_BASE, username: config?.username || '', userId: config?.userId || null,
      enabled: !!config?.enabled, tabId: config?.tabId ?? null, resumeId: config?.resumeId ?? null, defaultResumeName: config?.defaultResumeName || '',
      phase: config?.enabled && !online ? 'awaiting_boss_page' : this.phase,
      online, lastError: this.lastError, pendingResults: Object.values(account?.receipts || {}).filter(item => !item.uploaded).length,
      pendingEffects: Object.values(account?.receipts || {}).flatMap(item => item.effects).filter(item => !item.done).length,
      tools: TOOL_CATALOG,
    }
  }
  private reconciliation(tool: string): ToolResult {
    return { ok: false, error: 'reconciliation_required', data: { tool, mayHaveExecuted: true, retrySafe: false, verifyWith: ['get_page_state', 'read_messages', 'list_pending_cards', 'list_threads'] } }
  }
  private async tick(payload: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const config = this.state.config
    if (!config?.enabled || config.tabId !== sender.tab!.id) return { ok: false, phase: 'disabled_or_unselected_tab' }
    if (payload.wakeGeneration !== undefined && payload.wakeGeneration !== `${this.schedulerEpoch}:${this.revision}`) return { ok: false, phase: 'stale_wake' }
    const version = payload.lifecycleVersion === undefined ? 0 : payload.lifecycleVersion
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return { ok: false, phase: 'invalid_lifecycle' }
    const documentKey = `${sender.tab!.id}:${sender.documentId}`
    const lifecycle = this.pageLifecycle.get(documentKey)
    if (lifecycle && (version < lifecycle.version || (lifecycle.frozen && version <= lifecycle.version))) return { ok: false, phase: 'page_frozen' }
    this.pageLifecycle.set(documentKey, { version, frozen: false })
    if (this.pageLifecycle.size > 20) this.pageLifecycle.delete(this.pageLifecycle.keys().next().value!)
    const now = this.now()
    const next = { tabId: sender.tab!.id!, documentId: sender.documentId!, visibility: payload.visibility === 'hidden' ? 'hidden' : 'visible', seenAt: now }
    this.connection = next
    if (now - this.lastTick < 700) return { ok: true, phase: this.phase }
    this.lastTick = now
    const session = this.session()
    const account = this.account(session)
    try {
      if (account.navigation) {
        const sameDocument = account.navigation.tabId === next.tabId && account.navigation.fromDocumentId === next.documentId
        if (sameDocument && now - account.navigation.startedAt <= 30_000) {
          this.phase = 'awaiting_navigation'
          return { ok: false, phase: this.phase }
        }
        if (sameDocument) {
          this.lastError = 'navigation_not_confirmed'
          account.diagnosticOnly = true
          this.finishPendingThread(account, fail('navigation_not_confirmed'))
        }
        account.navigation = undefined
        await this.save()
      }
      await this.flush(session, account)
      this.assertActive(session)
      const hadPendingThread = !!account.pendingThread
      await this.resumePendingThread(session, account, next)
      this.assertActive(session)
      if (hadPendingThread && !account.pendingThread) await this.flush(session, account)
      const heartbeat = await this.request(session.config, '/api/plugin/heartbeat', {
        platform: 'zhipin', version: this.api.runtime.getManifest().version,
        protocol_version: 2, capabilities: ['command_ack_v2', 'tools_v1'], tools: TOOL_CATALOG,
        phase: account.diagnosticOnly ? 'diagnostic_only' : 'tool_ready', running: false, visibility: next.visibility,
        ack_command_id: account.ack, ack_command_epoch: account.epoch || null,
        last_error: this.lastError || null,
      }, session)
      this.assertActive(session)
      const compatibility = object(heartbeat.plugin_compatibility)
      if (compatibility.can_receive_commands !== true || typeof heartbeat.command_epoch !== 'string' || !heartbeat.command_epoch) {
        this.phase = 'protocol_unconfirmed'; return { ok: false, phase: this.phase }
      }
      const epoch = heartbeat.command_epoch
      if (account.epoch !== epoch) { account.epoch = epoch; account.ack = 0; await this.save() }
      if (!Array.isArray(heartbeat.commands)) { this.phase = 'invalid_commands'; return { ok: false, phase: this.phase } }
      this.phase = account.diagnosticOnly ? 'diagnostic_only' : 'tool_ready'
      for (const raw of heartbeat.commands) {
        this.assertActive(session)
        const command = object(raw) as unknown as RemoteCommand
        if (!number(command.id) || typeof command.action !== 'string') { this.lastError = 'invalid_command'; break }
        if (command.id <= account.ack) continue
        // Unknown actions MUST stop the ordered ACK cursor; advancing it would ACK actions we never executed.
        if (command.action !== 'tool.call') { this.lastError = 'unsupported_command'; break }
        const tool = String(object(command.payload).name || '')
        const declaration = TOOL_CATALOG.find(item => item.name === tool)
        if (!declaration) { this.lastError = 'unknown_tool'; break }
        const key = receiptKey(epoch, command.id)
        let receipt = account.receipts[key]
        if (!receipt) {
          if (Object.values(account.receipts).filter(item => !item.uploaded || item.effects.some(effect => !effect.done)).length >= MAX_PENDING || new TextEncoder().encode(JSON.stringify(this.state)).length > MAX_STATE_BYTES) {
            this.lastError = 'outbox_full'; break
          }
          receipt = { commandId: command.id, epoch, tool, state: 'started', irreversible: declaration.irreversible, uploaded: false, effects: [], document: { tabId: next.tabId, documentId: next.documentId } }
          account.receipts[key] = receipt
          await this.save() // The started receipt always reaches disk before any page action.
          if (account.diagnosticOnly && !DIAGNOSTIC_TOOLS.has(tool)) {
            // A known but unsafe action gets a terminal refusal, so it cannot block later diagnostics.
            receipt.result = fail('navigation_recovery_required')
            receipt.state = 'done'
            await this.save()
          } else {
            await this.execute(session, account, receipt, object(command.payload).args, next)
            if (tool === 'open_thread' && receipt.result?.ok && receipt.result.data === 'ok' && !receipt.effects.length) {
              account.diagnosticOnly = false
              this.lastError = ''
            }
          }
          this.phase = account.diagnosticOnly ? 'diagnostic_only' : 'tool_ready'
        }
        if (receipt.state !== 'done') { receipt.state = 'done'; receipt.result = this.reconciliation(tool); await this.save() }
        account.ack = command.id
        await this.save() // Result + ACK survive navigation and service-worker eviction.
        await this.flush(session, account)
        if (receipt.effects.some(effect => effect.effect.kind === 'navigate' || effect.effect.kind === 'reload')) break
      }
      return { ok: true, phase: this.phase }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'runtime_error'
      this.phase = this.active(session) ? 'awaiting_retry' : 'session_changed'
      return { ok: false, phase: this.phase, error: this.lastError }
    }
  }
  private async ensurePage(session: Session, connection: PageConnection, assertCall: () => void): Promise<void> {
    this.assertActive(session)
    assertCall()
    const tab = await this.api.tabs.get(connection.tabId)
    assertCall()
    if (!bossUrl(tab.url) || this.connection?.documentId !== connection.documentId || this.state.config?.tabId !== connection.tabId) throw new Error('page_changed')
    const key = `${connection.tabId}:${connection.documentId}`
    if (this.pageReady !== key) {
      await this.api.scripting.executeScript({ target: { tabId: connection.tabId, documentIds: [connection.documentId] }, world: 'MAIN', files: ['page.js'] })
      this.assertActive(session)
      assertCall()
      this.pageReady = key
    }
  }
  private async page(session: Session, connection: PageConnection, method: 'run' | 'prepare', invocation: PageInvocation): Promise<PageExecution | ToolResult> {
    const call = { connection, key: invocation.commandKey, controller: new AbortController() }
    this.activePageCall = call
    const expiresAt = Date.now() + PAGE_TIMEOUT_MS
    const deadline = setTimeout(() => {
      void this.cancelPage(connection, invocation.commandKey)
      call.controller.abort()
    }, PAGE_TIMEOUT_MS)
    let removeAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error('session_changed'))
      call.controller.signal.addEventListener('abort', abort, { once: true })
      removeAbort = () => call.controller.signal.removeEventListener('abort', abort)
    })
    const assertCall = () => {
      this.assertActive(session)
      if (call.controller.signal.aborted) throw new Error('page_execution_cancelled')
    }
    const execution = (async () => {
      await this.ensurePage(session, connection, assertCall)
      assertCall()
      const epochs = await this.api.scripting.executeScript({
        target: { tabId: connection.tabId, documentIds: [connection.documentId] }, world: 'MAIN',
        func: (key: string) => {
          const runtime = (globalThis as unknown as Record<string, { lifecycleEpoch?: () => number }>)[key]
          if (typeof runtime?.lifecycleEpoch !== 'function') throw new Error('page_runtime_unavailable')
          return runtime.lifecycleEpoch()
        }, args: [PAGE_RUNTIME_KEY],
      })
      assertCall()
      const expectedEpoch = epochs[0]?.result
      if (typeof expectedEpoch !== 'number' || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) throw new Error('page_lifecycle_changed')
      const results = await this.api.scripting.executeScript({
        target: { tabId: connection.tabId, documentIds: [connection.documentId] }, world: 'MAIN',
        func: async (key: string, mode: 'run' | 'prepare', request: PageInvocation, expected: number, expires: number) => {
          const runtime = (globalThis as unknown as Record<string, { lifecycleEpoch?: () => number; run: (value: PageInvocation) => Promise<PageExecution>; prepare: (value: PageInvocation) => Promise<ToolResult> }>)[key]
          if (!runtime) throw new Error('page_runtime_unavailable')
          if (typeof runtime.lifecycleEpoch !== 'function' || runtime.lifecycleEpoch() !== expected || Date.now() >= expires) throw new Error('page_lifecycle_changed')
          return runtime[mode](request)
        }, args: [PAGE_RUNTIME_KEY, method, invocation, expectedEpoch, expiresAt],
      })
      const result = results[0]?.result
      if (!result || typeof result !== 'object') throw new Error('page_result_missing')
      return result
    })()
    try { return await Promise.race([execution, cancelled]) }
    finally {
      clearTimeout(deadline)
      removeAbort?.()
      if (this.activePageCall === call) this.activePageCall = null
    }
  }
  private async execute(session: Session, _account: AccountState, receipt: Receipt, rawArgs: unknown, connection: PageConnection): Promise<void> {
    try {
      const validation = validateToolArgs(receipt.tool, rawArgs)
      if (!validation.ok) { receipt.result = validation; receipt.state = 'done'; await this.save(); return }
      const args = rawArgs as Record<string, unknown>
      this.phase = 'executing'
      const invocation: PageInvocation = { commandKey: await pageCommandKey(`${session.accountKey}|${receiptKey(receipt.epoch, receipt.commandId)}`), name: receipt.tool, args, context: { defaultResumeName: session.config.defaultResumeName } }
      if (receipt.tool === 'apply_job') {
        if (!session.config.resumeId) { receipt.result = fail('resume_required'); receipt.state = 'done'; await this.save(); return }
        const prepared = await this.page(session, connection, 'prepare', invocation) as ToolResult
        this.assertActive(session)
        if (!prepared.ok) { receipt.result = prepared; receipt.state = 'done'; await this.save(); return }
        const job = object(object(prepared.data).job)
        if (typeof job.platformJobId !== 'string' || typeof job.title !== 'string') throw new Error('invalid_prepared_job')
        const greeting = await this.request(session.config, '/api/plugin/greeting', {
          resume_id: session.config.resumeId, platform: 'zhipin', platform_job_id: job.platformJobId,
          title: job.title, company: job.company || '', description: job.description || job.jd || '',
        }, session)
        this.assertActive(session)
        if (typeof greeting.greeting !== 'string' || !greeting.greeting.trim()) { receipt.result = fail('greeting_unavailable'); receipt.state = 'done'; await this.save(); return }
        invocation.context!.greeting = greeting.greeting
      }
      this.assertActive(session)
      const execution = await this.page(session, connection, 'run', invocation) as PageExecution
      receipt.result = execution.result && typeof execution.result.ok === 'boolean' ? execution.result : this.reconciliation(receipt.tool)
      if (new TextEncoder().encode(JSON.stringify(receipt.result)).length > MAX_RESULT_BYTES) {
        receipt.result = { ok: receipt.result.ok, error: receipt.result.error, data: { truncated: true, reason: 'result_exceeds_extension_budget', retrySafe: !receipt.irreversible } }
      }
      receipt.effects = pageEffects(receipt.tool, execution.effects, session.config.resumeId).map(effect => ({ effect, done: false }))
      receipt.state = 'done'
      await this.save()
    } catch (error) {
      receipt.state = 'done'
      receipt.effects = []
      receipt.result = this.reconciliation(receipt.tool)
      if (error instanceof Error && error.message === 'invalid_page_effect') receipt.result.data = { ...object(receipt.result.data), reason: 'invalid_page_effect' }
      await this.save()
    }
  }
  private async flush(session: Session, account: AccountState): Promise<void> {
    let effectFailure: unknown
    for (const receipt of Object.values(account.receipts)) {
      if (receipt.state !== 'done') continue
      this.assertActive(session)
      try {
        const effects = pageEffects(receipt.tool, receipt.effects.map(item => item.effect), null, true)
        receipt.effects = effects.map((effect, index) => ({ ...receipt.effects[index], effect }))
      } catch {
        receipt.effects = []
        receipt.result = this.reconciliation(receipt.tool)
        receipt.result.data = { ...object(receipt.result.data), reason: 'invalid_page_effect' }
        receipt.uploaded = false
        await this.save()
      }
      for (const effect of receipt.effects) {
        if (effect.done) continue
        this.assertActive(session)
        if (effect.effect.kind === 'application' || effect.effect.kind === 'conversation_deleted') {
          try {
            await this.request(session.config, effect.effect.kind === 'application' ? '/api/plugin/record' : '/api/plugin/chat/mark-deleted', effect.effect.payload, session)
            effect.done = true
            await this.save()
          } catch (error) {
            this.assertActive(session)
            // A failed bookkeeping API must not hide the real page result from the Agent.
            effectFailure = error
          }
        }
      }
      if (!receipt.uploaded) {
        const result = receipt.result || this.reconciliation(receipt.tool)
        await this.request(session.config, '/api/plugin/tools/result', {
          command_id: receipt.commandId, tool: receipt.tool, ok: result.ok, data: result.data ?? null, error: result.error || '',
        }, session)
        receipt.uploaded = true
        await this.save()
      }
      for (const item of receipt.effects) {
        if (item.done || (item.effect.kind !== 'navigate' && item.effect.kind !== 'reload')) continue
        this.assertActive(session)
        const config = this.requireConfig()
        if (!config.enabled || !config.tabId) return
        if (receipt.document && (receipt.document.tabId !== config.tabId || receipt.document.documentId !== this.connection?.documentId)) {
          item.done = true
          this.lastError = 'navigation_cancelled_after_context_change'
          await this.save()
          continue
        }
        // These effects are attempted once. A crash between intent and chrome.tabs cannot loop navigation.
        if (item.started) { item.done = true; await this.save(); continue }
        item.started = true
        if (item.effect.kind === 'navigate' && !bossUrl(item.effect.url)) { item.done = true; this.lastError = 'navigation_origin_forbidden'; await this.save(); continue }
        if (item.effect.kind === 'navigate' && item.effect.pendingThread) {
          account.pendingThread = { ...item.effect.pendingThread, fromDocumentId: this.connection?.documentId || '', commandId: receipt.commandId, epoch: receipt.epoch, attempts: 0 }
        }
        account.navigation = { tabId: config.tabId, fromDocumentId: this.connection?.documentId || '', startedAt: this.now() }
        await this.save()
        if (item.effect.kind === 'navigate') await this.api.tabs.update(config.tabId, { url: item.effect.url })
        else await this.api.tabs.reload(config.tabId)
        item.done = true
        this.pageReady = ''
        await this.save()
      }
    }
    // Retain compact durable receipts for every ACK; keep only pending result bodies after successful upload.
    let compacted = false
    for (const receipt of Object.values(account.receipts)) {
      if (receipt.uploaded && receipt.result !== undefined && receipt.effects.every(item => item.done)) { receipt.result = undefined; compacted = true }
    }
    const completed = Object.entries(account.receipts).filter(([, receipt]) => receipt.uploaded && receipt.effects.every(item => item.done)).sort((a, b) => b[1].commandId - a[1].commandId)
    for (const [key] of completed.slice(200)) { delete account.receipts[key]; compacted = true }
    if (compacted) await this.save()
    if (effectFailure) throw effectFailure
  }
  private finishPendingThread(account: AccountState, result: ToolResult): void {
    const pending = account.pendingThread
    if (!pending) return
    const receipt = account.receipts[receiptKey(pending.epoch ?? account.epoch, pending.commandId ?? account.ack)]
    if (receipt?.tool === 'open_thread') {
      receipt.result = result
      receipt.uploaded = false // Replace the intermediate "navigating" result with the actual outcome.
    }
    account.pendingThread = undefined
  }
  private async resumePendingThread(session: Session, account: AccountState, connection: PageConnection): Promise<void> {
    const pending = account.pendingThread
    if (!pending || pending.fromDocumentId === connection.documentId) return
    if ((pending.attempts ?? 0) >= 5) {
      this.finishPendingThread(account, fail('pending_thread_interrupted'))
      account.diagnosticOnly = true
      this.lastError = 'pending_thread_interrupted'
      await this.save()
      return
    }
    pending.attempts = (pending.attempts ?? 0) + 1
    await this.save()
    const result = await this.page(session, connection, 'run', {
      commandKey: await pageCommandKey(`${session.accountKey}|pending-thread|${pending.epoch ?? account.epoch}|${pending.commandId ?? account.ack}|${pending.attempts}`), name: 'open_thread',
      args: { company: pending.company, jobTitle: pending.jobTitle }, context: { defaultResumeName: session.config.defaultResumeName },
    }) as PageExecution
    this.assertActive(session)
    // A navigation response is not evidence that the target conversation opened.
    const opened = result.result.ok && result.result.data === 'ok' && !result.effects?.length
    if (opened) {
      this.finishPendingThread(account, result.result)
      account.diagnosticOnly = false
      this.lastError = ''
    } else if (pending.attempts >= 5) {
      const error = result.result.error || 'pending_thread_not_ready'
      this.finishPendingThread(account, { ok: false, error, data: { navigationCompleted: false, verifyWith: ['list_threads', 'get_page_state'], recoverWith: 'open_thread' } })
      account.diagnosticOnly = true
      this.lastError = `pending_thread_${error}`
    } else {
      throw new Error(result.result.error || 'pending_thread_not_ready')
    }
    await this.save()
  }
}

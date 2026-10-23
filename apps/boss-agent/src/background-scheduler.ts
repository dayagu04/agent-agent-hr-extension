import type { SchedulerTarget } from './runtime'

export const RECOVERY_ALARM = 'boss-agent-heartbeat-recovery-v1'
const POLL_MS = 2000
const WAKE_TIMEOUT_MS = 5000
interface NativeProof { tabId: number; documentId: string; generation?: string }
interface Wake { key: string; generation: string; active: boolean; expired: boolean; timeout: ReturnType<typeof setTimeout> | null }
interface SchedulerDependencies {
  chrome: Pick<typeof chrome, 'tabs' | 'alarms'>
  target: () => Promise<SchedulerTarget>
}
function key(target: SchedulerTarget): string { return `${target.generation}|${target.enabled}|${target.tabId}|${target.documentId}` }

/** Every short wake requests real heartbeat work in the explicitly selected document. */
export class BossHeartbeatScheduler {
  private readonly api: SchedulerDependencies['chrome']
  private readonly target: SchedulerDependencies['target']
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Wake | null = null
  private currentKey = ''
  private blockedKey = ''
  private alarmEnabled: boolean | null = null
  private alarmQueue: Promise<void> = Promise.resolve()
  constructor(dependencies: SchedulerDependencies) { this.api = dependencies.chrome; this.target = dependencies.target }

  async start(): Promise<void> {
    this.api.alarms.onAlarm.addListener(alarm => { if (alarm.name === RECOVERY_ALARM) void this.recover().catch(() => undefined) })
    await this.refresh()
  }
  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null }
  private syncAlarm(enabled: boolean): Promise<void> {
    const operation = this.alarmQueue.then(async () => {
      const wanted = await this.target()
      if ((wanted.enabled && wanted.tabId !== null) !== enabled || this.alarmEnabled === enabled) return
      if (enabled) {
        // Serialize get/create/clear: a late enable cannot recreate the alarm after a completed disable.
        const existing = await this.api.alarms.get(RECOVERY_ALARM)
        const current = await this.target()
        if (!current.enabled || current.tabId === null) return
        if (!existing) await this.api.alarms.create(RECOVERY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 })
      } else await this.api.alarms.clear(RECOVERY_ALARM)
      this.alarmEnabled = enabled // Failed Chrome operations leave the cache unchanged and can be retried.
    })
    this.alarmQueue = operation.catch(() => undefined)
    return operation
  }

  /** A proof comes only after BossRuntime has accepted a native top-frame content-script message. */
  async refresh(proof?: NativeProof): Promise<void> {
    const target = await this.target()
    const targetKey = key(target)
    if (this.currentKey !== targetKey) {
      this.currentKey = targetKey
      this.clearTimer()
      this.blockedKey = ''
      if (this.pending) this.pending.active = false
    }
    await this.syncAlarm(target.enabled && target.tabId !== null)
    // Re-read after the asynchronous Chrome API, so an old control response cannot restore a stale schedule.
    if (key(await this.target()) !== targetKey || this.currentKey !== targetKey) return
    const proved = proof && target.enabled && target.documentId === proof.documentId && target.tabId === proof.tabId &&
      (proof.generation === undefined || proof.generation === target.generation)
    if (proved) {
      this.blockedKey = ''
      // A newly runnable native document is the only way to abandon an expired, uncancellable Chrome sendMessage.
      if (this.pending && (this.pending.expired || !this.pending.active)) {
        this.pending.active = false
        if (this.pending.timeout !== null) clearTimeout(this.pending.timeout)
        this.pending = null
      }
    }
    if (!target.enabled || target.tabId === null || !target.documentId) { this.clearTimer(); return }
    if (this.pending || this.timer !== null || this.blockedKey === targetKey) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll(targetKey).catch(() => undefined)
    }, POLL_MS)
  }
  private async poll(expectedKey: string): Promise<void> {
    const target = await this.target()
    if (key(target) !== expectedKey || this.currentKey !== expectedKey || !target.enabled || target.tabId === null || !target.documentId || this.pending || this.blockedKey === expectedKey) return
    this.wake(target, false)
  }
  /** After eviction or a stopped loop, ask only the persisted selected tab to establish a fresh native document proof. */
  async recover(): Promise<void> {
    await this.refresh()
    const target = await this.target()
    if (!target.enabled || target.tabId === null || this.pending) return
    this.clearTimer()
    this.wake(target, true)
  }
  private wake(target: SchedulerTarget, recovery: boolean): void {
    const wake: Wake = { key: key(target), generation: target.generation, active: true, expired: false, timeout: null }
    this.pending = wake
    wake.timeout = setTimeout(() => {
      wake.expired = true
      wake.active = false
      wake.timeout = null
      if (this.pending === wake) { this.blockedKey = wake.key; this.clearTimer() }
      // Keep the pending marker: alarms must not pile up more messages in a frozen page.
    }, WAKE_TIMEOUT_MS)
    void this.api.tabs.sendMessage(target.tabId!, { type: 'boss.wake', generation: target.generation }, recovery ? { frameId: 0 } : { documentId: target.documentId! }).then(
      async response => {
        if (wake.timeout !== null) clearTimeout(wake.timeout)
        if (this.pending === wake) this.pending = null
        if (!wake.active || wake.expired || this.currentKey !== wake.key || key(await this.target()) !== wake.key) return
        if (!response || response.runnable !== true || response.generation !== wake.generation) { this.blockedKey = wake.key; this.clearTimer(); return }
        await this.refresh()
      },
      () => {
        if (wake.timeout !== null) clearTimeout(wake.timeout)
        if (this.pending === wake) this.pending = null
        if (wake.active && this.currentKey === wake.key) { this.blockedKey = wake.key; this.clearTimer() }
      },
    ).catch(() => undefined)
  }
}

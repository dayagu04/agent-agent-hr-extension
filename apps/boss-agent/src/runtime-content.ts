interface ContentDependencies {
  runtime: Pick<typeof chrome.runtime, 'id' | 'sendMessage'>
  visibility: () => DocumentVisibilityState
}

/** Isolated-world heartbeat endpoint. It has no credentials, page actions, or generic API proxy. */
export class BossContentHeartbeat {
  private readonly runtime: ContentDependencies['runtime']
  private readonly visibility: ContentDependencies['visibility']
  private pending: Promise<unknown> | null = null
  private frozen = false
  private lifecycleVersion = 0
  constructor(dependencies: ContentDependencies) { this.runtime = dependencies.runtime; this.visibility = dependencies.visibility }
  tick(generation?: string): Promise<unknown> {
    if (this.frozen) return Promise.resolve({ ok: false, error: 'page_frozen' })
    if (this.pending) return this.pending
    const message = { type: 'boss.tick', visibility: this.visibility(), lifecycleVersion: this.lifecycleVersion, ...(generation === undefined ? {} : { wakeGeneration: generation }) }
    this.pending = Promise.resolve().then(() => this.runtime.sendMessage(message))
      .catch(() => ({ ok: false, error: 'background_unavailable' }))
      .finally(() => { this.pending = null })
    return this.pending
  }
  async wake(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const value = message as { type?: unknown; generation?: unknown } | null
    if (sender.id !== this.runtime.id || sender.tab || value?.type !== 'boss.wake' || typeof value.generation !== 'string' || !value.generation || value.generation.length > 128) return { runnable: false }
    if (this.frozen) return { runnable: false, generation: value.generation }
    await this.tick(value.generation)
    return { runnable: !this.frozen, generation: value.generation }
  }
  async freeze(): Promise<void> {
    this.frozen = true
    this.lifecycleVersion += 1
    await Promise.resolve().then(() => this.runtime.sendMessage({ type: 'boss.lifecycle', state: 'frozen', lifecycleVersion: this.lifecycleVersion })).catch(() => undefined)
  }
  resume(): Promise<unknown> {
    this.frozen = false
    this.lifecycleVersion += 1
    return this.pending ? this.pending.then(() => this.tick()) : this.tick()
  }
}

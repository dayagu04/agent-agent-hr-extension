import { BossRuntime } from './runtime'

const runtime = new BossRuntime({ chrome, fetch: globalThis.fetch.bind(globalThis) })
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  void runtime.handle(message, sender).then(reply, (error: unknown) => {
    reply({ ok: false, error: error instanceof Error ? error.message : 'runtime_error' })
  })
  return true
})

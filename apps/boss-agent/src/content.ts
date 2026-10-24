import { BossContentHeartbeat } from './runtime-content'

const heartbeat = new BossContentHeartbeat({ runtime: chrome.runtime, visibility: () => document.visibilityState })
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'boss.wake') return false
  void heartbeat.wake(message, sender).then(reply, () => reply({ runnable: false }))
  return true
})
// Native ticks restore the connection after navigation. Hidden-page cadence is provided by real background wake messages.
setInterval(() => { void heartbeat.tick() }, 10_000)
document.addEventListener('visibilitychange', () => { void heartbeat.tick() })
document.addEventListener('freeze', () => { void heartbeat.freeze() })
document.addEventListener('resume', () => { void heartbeat.resume() })
window.addEventListener('pageshow', () => { void heartbeat.resume() })
window.addEventListener('focus', () => { void heartbeat.tick() })
void heartbeat.tick()

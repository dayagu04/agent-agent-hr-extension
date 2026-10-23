// The isolated-world content script has no API, credentials, or page action dispatcher.
let pending = false
async function tick(): Promise<void> {
  if (pending) return
  pending = true
  try {
    await chrome.runtime.sendMessage({ type: 'boss.tick', visibility: document.visibilityState })
  } catch { /* Reloading or updating the extension invalidates this content-script context. */ }
  finally { pending = false }
}
setInterval(() => { void tick() }, 1000)
document.addEventListener('visibilitychange', () => { void tick() })
document.addEventListener('resume', () => { void tick() })
window.addEventListener('pageshow', () => { void tick() })
window.addEventListener('focus', () => { void tick() })
void tick()
export {}

import { PAGE_RUNTIME_KEY } from './contracts'
import { createPageTools } from './page-tools'

export type InstalledPageTools = ReturnType<typeof createPageTools> & { readonly lifecycleEpoch: () => number }
const page = globalThis as typeof globalThis & Record<typeof PAGE_RUNTIME_KEY, InstalledPageTools | undefined>
// Commands may inject this bundle repeatedly; do not discard in-flight leases or command receipts.
if (!page[PAGE_RUNTIME_KEY]) {
  let lifecycleEpoch = 0
  const runtime = createPageTools() as InstalledPageTools
  Object.defineProperty(runtime, 'lifecycleEpoch', { value: () => lifecycleEpoch, writable: false, configurable: false })
  Object.defineProperty(page, PAGE_RUNTIME_KEY, { value: runtime, writable: false, configurable: false })
  // Cancel synchronously before MAIN is suspended; a background injection may arrive only after resume.
  document.addEventListener('freeze', () => { lifecycleEpoch += 1; runtime.cancel() })
}

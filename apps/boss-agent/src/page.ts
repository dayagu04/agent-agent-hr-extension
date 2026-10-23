import { PAGE_RUNTIME_KEY } from './contracts'
import { createPageTools } from './page-tools'

const page = globalThis as typeof globalThis & Record<typeof PAGE_RUNTIME_KEY, ReturnType<typeof createPageTools> | undefined>
// Commands may inject this bundle repeatedly; do not discard in-flight leases or command receipts.
if (!page[PAGE_RUNTIME_KEY]) {
  const runtime = createPageTools()
  Object.defineProperty(page, PAGE_RUNTIME_KEY, { value: runtime, writable: false, configurable: false })
  // Cancel synchronously before MAIN is suspended; a background injection may arrive only after resume.
  document.addEventListener('freeze', () => runtime.cancel())
}

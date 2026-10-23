// Only the selected resume label enters MAIN; backend URL, IDs and JWT stay in the service worker.
import type { PluginConfig } from '../../../../src/types'
let defaultResumeName = ''
export function setPageResumeName(name = ''): void { defaultResumeName = name }
export function loadConfig(): PluginConfig {
  const allowed = { defaultSendResumeId: defaultResumeName ? 1 : null, resumeNames: defaultResumeName ? { '1': defaultResumeName } : {} }
  return new Proxy(allowed, {
    get(target, key) {
      if (key === 'defaultSendResumeId' || key === 'resumeNames') return target[key]
      throw new Error('page_config_not_available')
    },
  }) as PluginConfig
}
export function isConfigReady(): boolean { return false }
export function saveConfig(): never { throw new Error('page_config_not_available') }
export function applyPluginPreferences(): never { throw new Error('page_config_not_available') }

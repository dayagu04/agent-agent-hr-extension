import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
const ref = process.env.GITHUB_REF || ''
const selected = { boss: false, autofill: false, legacy: false, release: '' }
const all = () => Object.assign(selected, { boss: true, autofill: true, legacy: true })

if (ref.startsWith('refs/tags/')) {
  const tag = ref.slice('refs/tags/'.length)
  const product = tag.startsWith('boss-v') ? 'boss' : tag.startsWith('autofill-v') ? 'autofill' : /^v\d/.test(tag) ? 'legacy' : null
  if (!product) throw new Error(`Unsupported release tag: ${tag}`)
  const packagePath = product === 'boss' ? 'apps/boss-agent/package.json' : product === 'autofill' ? 'apps/application-autofill/package.json' : 'package.json'
  const { version } = JSON.parse(readFileSync(resolve(root, packagePath), 'utf8'))
  const expected = `${product === 'boss' ? 'boss-v' : product === 'autofill' ? 'autofill-v' : 'v'}${version}`
  if (tag !== expected) throw new Error(`Tag ${tag} does not match ${packagePath}: expected ${expected}`)
  selected[product] = true
  selected.release = product
} else {
  const base = event.pull_request?.base?.sha || event.before
  if (!base || /^0+$/.test(base) || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    all()
  } else {
    let paths
    try {
      paths = execFileSync('git', ['diff', '--name-only', '-z', base, process.env.GITHUB_SHA || 'HEAD'], { cwd: root }).toString().split('\0').filter(Boolean)
    } catch {
      all() // missing history fails closed to every product
      paths = []
    }
    for (const path of paths) {
      if (path.startsWith('apps/boss-agent/')) selected.boss = true
      else if (path.startsWith('apps/application-autofill/')) selected.autofill = true
      else if (path.startsWith('src/') || path === 'vite.config.ts' || path.startsWith('vitest.config.') || path.startsWith('tsconfig.')) {
        selected.boss = true // page bridge deliberately reuses the legacy DOM tools
        selected.legacy = true
      } else if (path.endsWith('.md') || path.startsWith('docs/') || ['LICENSE', '.gitignore'].includes(path)) {
        // Documentation and ignored-file policy do not change executable inputs.
      } else all() // shared lock, CI, build tooling, deletion/unknown paths
    }
  }
}

for (const [name, value] of Object.entries(selected)) {
  const line = `${name}=${value}\n`
  process.stdout.write(line)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
}

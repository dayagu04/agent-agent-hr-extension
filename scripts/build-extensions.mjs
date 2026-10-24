import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { checkExtension, products } from './check-extension-artifacts.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const selected = process.argv.slice(2)
if (selected.some(name => !Object.hasOwn(products, name))) throw new Error(`Unknown extension: ${selected.join(', ')}`)

function run(cli, args, cwd = root) {
  if (!existsSync(cli)) throw new Error(`Missing dependencies at ${cli}; run npm ci in ${cwd}`)
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

for (const name of selected.length ? selected : Object.keys(products)) {
  if (name === 'boss-agent') {
    for (const config of ['vite.config.ts', 'vite.content.config.ts', 'vite.page.config.ts']) {
      run(resolve(root, 'node_modules/vite/bin/vite.js'), ['build', '--config', `apps/boss-agent/${config}`])
    }
  } else {
    const app = resolve(root, 'apps/application-autofill')
    for (const config of ['vite.config.ts', 'vite.content.config.ts', 'vite.auth-sync.config.ts']) {
      run(resolve(app, 'node_modules/vite/bin/vite.js'), ['build', '--config', config], app)
    }
    checkExtension(name, resolve(app, 'dist'))
    const destination = resolve(root, 'dist', name)
    // Never empty the shared dist directory or another product's installed files.
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    cpSync(resolve(app, 'dist'), destination, { recursive: true })
  }
  checkExtension(name, resolve(root, 'dist', name))
}

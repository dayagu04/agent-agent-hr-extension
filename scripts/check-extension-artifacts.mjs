import assert from 'node:assert/strict'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'

const root = fileURLToPath(new URL('..', import.meta.url))
export const products = {
  'boss-agent': { app: 'apps/boss-agent', tag: 'boss-v' },
  'application-autofill': { app: 'apps/application-autofill', tag: 'autofill-v' },
}

export function artifactFiles(directory) {
  const files = new Map()
  function walk(path) {
    for (const entry of readdirSync(path)) {
      const full = resolve(path, entry)
      const stat = lstatSync(full)
      assert.ok(!stat.isSymbolicLink(), `Artifact contains symlink: ${full}`)
      if (stat.isDirectory()) walk(full)
      else files.set(relative(directory, full).replaceAll('\\', '/'), readFileSync(full))
    }
  }
  walk(directory)
  return files
}

export function checkFiles(name, files) {
  const product = products[name]
  assert.ok(product, `Unknown extension: ${name}`)
  const pkg = JSON.parse(readFileSync(resolve(root, product.app, 'package.json'), 'utf8'))
  assert.ok(files.has('manifest.json'), `${name}: missing manifest`)
  const manifest = JSON.parse(files.get('manifest.json').toString())
  assert.equal(manifest.manifest_version, 3, `${name}: requires Manifest V3`)
  assert.equal(manifest.version, pkg.version, `${name}: package/manifest version mismatch`)
  assert.equal(manifest.background?.service_worker, 'background.js')
  assert.equal(manifest.background?.type, 'module')
  assert.equal(manifest.action?.default_popup, 'popup.html')
  const allowedPermissions = name === 'boss-agent'
    ? ['storage', 'alarms', 'scripting', 'activeTab']
    : ['activeTab', 'scripting', 'storage']
  for (const permission of manifest.permissions || []) {
    assert.ok(allowedPermissions.includes(permission), `${name}: unexpected permission ${permission}`)
  }
  const allowedHosts = name === 'boss-agent'
    ? ['https://www.zhipin.com/*', 'https://gudaya.chat/*', 'https://www.gudaya.chat/*', 'http://127.0.0.1/*', 'http://localhost/*']
    : ['https://gudaya.chat/*', 'https://www.gudaya.chat/*']
  for (const host of manifest.host_permissions || []) {
    assert.ok(allowedHosts.includes(host), `${name}: unexpected host permission ${host}`)
  }
  const allowedOptionalHosts = name === 'boss-agent'
    ? ['https://*/*', 'http://127.0.0.1/*', 'http://localhost/*']
    : []
  for (const host of manifest.optional_host_permissions || []) {
    assert.ok(allowedOptionalHosts.includes(host), `${name}: unexpected optional host permission ${host}`)
  }
  const referenced = ['background.js', 'popup.html', ...Object.values(manifest.icons || {})]
  for (const entry of manifest.content_scripts || []) {
    assert.ok(entry.matches.every(match => !match.includes('<all_urls>') && match !== '*://*/*'), `${name}: broad content script`)
    for (const script of entry.js || []) {
      referenced.push(script)
      assert.doesNotThrow(() => new Script(files.get(script)?.toString() || '', { filename: script }), `${name}: content script must be a classic script`)
    }
  }
  for (const entry of manifest.web_accessible_resources || []) {
    referenced.push(...(entry.resources || []).filter(resource => !resource.includes('*')))
  }
  for (const path of referenced) {
    assert.ok(!path.startsWith('/') && !path.includes('..') && !/^https?:/.test(path), `${name}: nonlocal asset ${path}`)
    assert.ok(files.has(path), `${name}: missing ${path}`)
  }
  for (const [path, bytes] of files) {
    assert.ok(!/(^|\/)(node_modules|\.git)(\/|$)/.test(path), `${name}: unexpected source/dependencies ${path}`)
    if (!/\.(?:js|html)$/.test(path)) continue
    const source = bytes.toString()
    assert.ok(!/\b(?:import\s*(?:\(\s*)?|from\s*)["']https?:\/\//.test(source), `${name}: remote executable import in ${path}`)
    assert.ok(!/<script[^>]+src\s*=\s*["']https?:\/\//i.test(source), `${name}: remote script in ${path}`)
    assert.ok(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(source), `${name}: dynamic executable code in ${path}`)
  }
  if (name === 'boss-agent') {
    const page = files.get('page.js')?.toString()
    assert.ok(page, 'BOSS MAIN-world bundle missing')
    assert.doesNotThrow(() => new Script(page, { filename: 'page.js' }))
    assert.ok(!/GM_|XMLHttpRequest|\bfetch\s*\(|VITE_DEV_UPDATE_URL|chrome\.storage|chrome\.runtime|\bBearer\b|\bAuthorization\b|\/api\/plugin|network\.request/.test(page), 'BOSS MAIN bundle contains privileged/network runtime')
  }
  return { name, version: manifest.version, files: files.size }
}

export function checkExtension(name, directory = resolve(root, 'dist', name)) {
  const result = checkFiles(name, artifactFiles(directory))
  console.log(`Verified ${result.name} v${result.version}: ${result.files} bundled files`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const selected = process.argv.slice(2)
  for (const name of selected.length ? selected : Object.keys(products)) checkExtension(name)
}

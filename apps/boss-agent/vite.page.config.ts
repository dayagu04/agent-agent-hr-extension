import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const app = fileURLToPath(new URL('.', import.meta.url))
const repository = resolve(app, '../..')

// Only the MAIN-world page bundle receives these substitutions. The background
// keeps the authenticated API client; the page gets data/DOM-only facades.
function pageFacades(): Plugin {
  const facades = new Map(['logger', 'config', 'api', 'ledger'].map(name => [
    resolve(repository, `src/${name}.ts`),
    resolve(app, `src/page/${name === 'api' || name === 'ledger' ? 'forbidden-' : ''}${name}.ts`),
  ]))
  return {
    name: 'boss-page-facades',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      const target = resolve(dirname(importer.split('?')[0]), source)
      return facades.get(target) || facades.get(`${target}.ts`) || null
    },
  }
}

export default defineConfig({
  root: app,
  plugins: [pageFacades()],
  build: {
    outDir: resolve(app, '../../dist/boss-agent'),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(app, 'src/page.ts'),
      name: 'GuguBossAgentPage',
      formats: ['iife'],
      fileName: () => 'page.js',
    },
  },
})

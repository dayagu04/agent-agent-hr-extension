import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const app = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: app,
  build: {
    outDir: resolve(app, '../../dist/boss-agent'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(app, 'popup.html'),
        background: resolve(app, 'src/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})

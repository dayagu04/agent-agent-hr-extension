#!/usr/bin/env node
// 本地开发服务：监听源码改动自动重建，并把最新构建提供给已安装的插件拉取（自动更新）。
//
//   npm run dev:serve
//
// 首次使用：在 Tampermonkey 里安装一次 http://127.0.0.1:8017/agent-agent-hr-tampermonkey.user.js
// （它和 build:local 一样连本地后端，并且每次页面加载都会先拉这里的最新构建）。
// 之后改代码 → 自动重建 → 刷新 BOSS 页面（或调 reload_page 工具）即生效，不用重装。
//
// 环境变量：
//   AAH_DEV_PORT   服务端口，默认 8017
//   VITE_API_BASE  插件连的后端，默认 http://127.0.0.1:8010
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const PORT = Number(process.env.AAH_DEV_PORT || 8017)
const FILE = 'agent-agent-hr-tampermonkey.user.js'
const bundlePath = path.join(root, 'dist', FILE)
const updateUrl = `http://127.0.0.1:${PORT}/${FILE}`

const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const env = {
  ...process.env,
  VITE_API_BASE: process.env.VITE_API_BASE || 'http://127.0.0.1:8010',
  VITE_DEV_UPDATE_URL: updateUrl,
}

// vite build --watch：每次源码改动后重新产出 dist/*.user.js
const child = spawn(process.execPath, [viteCli, 'build', '--watch'], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => {
  console.error(`[dev-serve] vite 退出（code=${code}）`)
  process.exit(code ?? 1)
})

function versionOf(text) {
  return /@version\s+(\S+)/.exec(text)?.[1] || ''
}

http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', updateUrl)
    if (url.pathname === `/${FILE}`) {
      if (!fs.existsSync(bundlePath)) {
        res.writeHead(503).end('build not ready')
        return
      }
      // 每次都读磁盘：保证拿到的是刚重建的版本
      const text = fs.readFileSync(bundlePath, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-AAH-Version': versionOf(text),
      })
      res.end(text)
      return
    }
    if (url.pathname === '/version') {
      const text = fs.existsSync(bundlePath) ? fs.readFileSync(bundlePath, 'utf8') : ''
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ version: versionOf(text), ready: !!text }))
      return
    }
    res.writeHead(404).end('not found')
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[dev-serve] 自动更新地址：${updateUrl}`)
    console.log(`[dev-serve] 首次在 Tampermonkey 安装上面这个地址；之后刷新页面即可拿到最新构建`)
  })

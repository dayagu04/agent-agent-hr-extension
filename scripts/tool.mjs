#!/usr/bin/env node
// 命令行调用插件工具 —— 与上游 agent 走完全相同的接口，用于开发联调与验收。
//
//   node scripts/tool.mjs functions                     获取 function-call JSON Schema
//   node scripts/tool.mjs list                          列出插件上报的工具
//   node scripts/tool.mjs <tool> ['{"json":"args"}']    调一个工具并等结果
//
// 环境变量：
//   AAH_API      后端地址，默认 http://127.0.0.1:8010
//   AAH_TOKEN    直接给 JWT；不给则用 AAH_EMAIL / AAH_PASSWORD 登录
//   AAH_EMAIL    默认 test@local.dev
//   AAH_PASSWORD 默认 test1234
//   AAH_WAIT     等结果的秒数，默认 90
//   AAH_REQUEST_ID 可选：同一调用重试时复用，避免重复入队不可撤回动作
//
// 结果协议（GET /api/plugin/tools/result/{id}）：
//   200 state=done      → 结果就绪
//   202 state=queued    → 插件还没取走（可以继续等）
//   202 state=delivered → 插件已取走正在执行（不可撤回工具此时绝不能重发）
//   202 state=acked     → 插件已执行完但结果没传回（同样不能重发）
//   404                 → 命令不存在
// 本脚本超时只报告最后状态，从不自动重发。

const API = process.env.AAH_API || 'http://127.0.0.1:8010'
const WAIT_S = Number(process.env.AAH_WAIT || 90)

async function http(method, path, body, token) {
  const resp = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await resp.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: resp.status, json }
}

async function token() {
  if (process.env.AAH_TOKEN) return process.env.AAH_TOKEN
  const r = await http('POST', '/api/auth/login', {
    email: process.env.AAH_EMAIL || 'test@local.dev',
    password: process.env.AAH_PASSWORD || 'test1234',
  })
  if (r.status !== 200 || !r.json?.token) throw new Error(`登录失败 HTTP ${r.status}`)
  return r.json.token
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function callTool(tok, name, args) {
  const q = await http('POST', '/api/plugin/tools/call', {
    name, args,
    ...(process.env.AAH_REQUEST_ID ? { request_id: process.env.AAH_REQUEST_ID } : {}),
  }, tok)
  if (q.status !== 200) return { ok: false, error: `call_http_${q.status}`, detail: q.json?.detail }
  const id = q.json.command_id
  const deadline = Date.now() + WAIT_S * 1000
  let last = 'queued'
  while (Date.now() < deadline) {
    const r = await http('GET', `/api/plugin/tools/result/${id}`, undefined, tok)
    if (r.status === 200) return { command_id: id, ...r.json }
    if (r.status === 404) return { command_id: id, ok: false, error: 'command_not_found' }
    last = r.json?.state || last
    await sleep(1000)
  }
  return { command_id: id, ok: false, error: 'result_timeout', state: last }
}

async function main() {
  const [cmd, rawArgs] = process.argv.slice(2)
  if (!cmd) {
    console.error('用法: node scripts/tool.mjs functions | list | <tool> [json-args]')
    process.exit(2)
  }
  const tok = await token()
  if (cmd === 'functions') {
    const r = await http('GET', '/api/plugin/tools', undefined, tok)
    if (r.status !== 200) throw new Error(`工具目录不可用 HTTP ${r.status}`)
    console.log(JSON.stringify(r.json, null, 2))
    return
  }
  if (cmd === 'list') {
    const r = await callTool(tok, 'list_tools', {})
    console.log(JSON.stringify(r, null, 2))
    return
  }
  let args = {}
  if (rawArgs) {
    try {
      args = JSON.parse(rawArgs)
    } catch (e) {
      console.error(`参数不是合法 JSON: ${e.message}`)
      process.exit(2)
    }
  }
  const r = await callTool(tok, cmd, args)
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})

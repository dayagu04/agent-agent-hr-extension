#!/usr/bin/env node
// Agent and developers share the authenticated command/result API. Never re-enqueue on timeout.
import { randomUUID } from 'node:crypto'

const HELP = `用法: npm run tool -- <命令> [参数]
  status                       查询执行端连接、版本和协议（不入队）
  functions                    获取在线执行端的 function-call JSON Schema
  list                         调用页面 list_tools
  result <command_id>           查询一次已有命令结果（不入队）
  wait <command_id>             等待已有命令结果（不入队）
  <tool> ['{"json":"args"}']    调用工具并等待结果

环境变量: AAH_API（默认 http://127.0.0.1:8010）、AAH_TOKEN，
或 AAH_EMAIL / AAH_PASSWORD（仅本地默认测试账号）；AAH_WAIT（默认90秒）、
AAH_HTTP_TIMEOUT（默认15秒）、AAH_REQUEST_ID（同一次调用重试时复用）。
新调用自动生成 request_id 并在入队前输出；入队后立即输出 command_id。
超时/断网不代表页面失败；不可撤回动作先查原结果，不能换ID重发。`

let api, waitMs, httpMs
function seconds(value, fallback, name) {
  const result = Number(value ?? fallback)
  if (!Number.isFinite(result) || result <= 0 || result > 3600) throw new Error(`${name} 必须在 0 到 3600 秒之间`)
  return result * 1000
}
async function http(method, path, body, token, timeout = httpMs) {
  try {
    const response = await fetch(api + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeout))),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json
    try { json = await response.json() } catch { return { status: response.status, error: 'invalid_json_response' } }
    return { status: response.status, json }
  } catch (error) {
    return { status: 0, error: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'http_timeout' : 'connection_failed' }
  }
}
function failure(response, prefix) {
  return { ok: false, error: response.error || `${prefix}_http_${response.status}` }
}
async function token() {
  if (process.env.AAH_TOKEN) return process.env.AAH_TOKEN
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(api).hostname)
  if (!local && (!process.env.AAH_EMAIL || !process.env.AAH_PASSWORD)) throw new Error('远端服务需要显式 AAH_TOKEN 或 AAH_EMAIL / AAH_PASSWORD')
  const response = await http('POST', '/api/auth/login', {
    email: process.env.AAH_EMAIL || 'test@local.dev', password: process.env.AAH_PASSWORD || 'test1234',
  })
  if (response.status !== 200 || !response.json?.token) throw new Error(`登录失败: ${response.error || `HTTP ${response.status}`}`)
  return response.json.token
}
async function result(tok, id, timeout) {
  const response = await http('GET', `/api/plugin/tools/result/${id}`, undefined, tok, timeout)
  if (response.error) return { command_id: id, ...failure(response, 'result') }
  if (response.status === 200 && typeof response.json?.ok === 'boolean') {
    if (response.json.ok && response.json.tool === 'open_thread' && response.json.data === 'navigating') {
      return { ...response.json, command_id: id, ok: false, pending: true, result_ready: false, state: 'navigating' }
    }
    return { ...response.json, command_id: id }
  }
  if (response.status === 202 && ['queued', 'delivered', 'acked'].includes(response.json?.state)) {
    return { command_id: id, ok: false, pending: true, state: response.json.state }
  }
  return { command_id: id, ok: false, error: response.status === 404 ? 'command_not_found' : `result_http_${response.status}` }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(tok, id) {
  const deadline = Date.now() + waitMs
  let last
  while (Date.now() < deadline) {
    const value = await result(tok, id, Math.min(httpMs, deadline - Date.now()))
    if (!value.pending) return { ...value, ...(value.error && last ? { state: last } : {}) }
    last = value.state
    await sleep(Math.max(0, Math.min(1000, deadline - Date.now())))
  }
  return { command_id: id, ok: false, error: 'result_timeout', ...(last ? { state: last } : {}) }
}
async function call(tok, name, args) {
  const requestId = process.env.AAH_REQUEST_ID || randomUUID()
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw new Error('AAH_REQUEST_ID 必须为1至128位字母、数字或 _ . : -')
  // A lost POST response must still be recoverable with the same request_id.
  console.error(JSON.stringify({ request_id: requestId, tool: name }))
  const response = await http('POST', '/api/plugin/tools/call', { name, args, request_id: requestId }, tok)
  if (response.status !== 200 || response.error) return { request_id: requestId, ...failure(response, 'call') }
  const id = response.json?.command_id
  if (!Number.isSafeInteger(id) || id <= 0) return { request_id: requestId, ok: false, error: 'invalid_command_response' }
  console.error(JSON.stringify({ request_id: requestId, command_id: id, queued: true, irreversible: response.json.irreversible }))
  return { ...(await wait(tok, id)), request_id: requestId }
}
async function main() {
  const [cmd, raw, ...extra] = process.argv.slice(2)
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) { console.log(HELP); process.exitCode = cmd ? 0 : 2; return }
  if (extra.length || (['status', 'functions', 'list'].includes(cmd) && raw !== undefined)) throw new Error('参数数量不正确；使用 --help 查看用法')
  const url = new URL(process.env.AAH_API || 'http://127.0.0.1:8010')
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/') throw new Error('AAH_API 必须为 HTTP(S) 源地址')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远端 AAH_API 必须使用 HTTPS')
  api = url.origin
  waitMs = seconds(process.env.AAH_WAIT, 90, 'AAH_WAIT')
  httpMs = seconds(process.env.AAH_HTTP_TIMEOUT, 15, 'AAH_HTTP_TIMEOUT')
  let id, args = {}
  if (['result', 'wait'].includes(cmd)) {
    if (!/^[1-9]\d*$/.test(raw || '') || !Number.isSafeInteger(Number(raw))) throw new Error('command_id 必须为正整数')
    id = Number(raw)
  } else if (raw !== undefined) {
    try { args = JSON.parse(raw) } catch { throw new Error('工具参数不是合法 JSON') }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象')
  }
  const tok = await token()
  let value
  if (cmd === 'status' || cmd === 'functions') {
    const response = await http('GET', cmd === 'status' ? '/api/plugin/status' : '/api/plugin/tools', undefined, tok)
    if (response.status !== 200 || response.error) value = failure(response, cmd)
    else if (cmd === 'functions') value = response.json
    else {
      const fields = ['connected', 'platform', 'version', 'phase', 'running', 'visibility', 'last_seen', 'last_error', 'protocol_version', 'compatibility_status', 'command_upgrade_required']
      value = Object.fromEntries(fields.map(key => [key, response.json?.[key] ?? null]))
    }
  } else if (cmd === 'result') value = await result(tok, id)
  else if (cmd === 'wait') value = await wait(tok, id)
  else value = await call(tok, cmd === 'list' ? 'list_tools' : cmd, args)
  console.log(JSON.stringify(value, null, 2))
  process.exitCode = value?.pending ? 2 : value?.ok === false ? 1 : 0
}
main().catch(error => { console.error(error.message || String(error)); process.exitCode = 1 })

import './app.css'
import { apiPermissionPattern, DEFAULT_API_BASE, normalizeApiBase } from './runtime'

type Status = { authenticated: boolean; username: string; apiBase: string; userId: number; enabled: boolean; tabId: number | null; resumeId: number | null; defaultResumeName: string; phase: string; online: boolean; pendingResults: number; pendingEffects: number; lastError: string; tools?: Array<{ name: string; irreversible: boolean }>; resumes?: Array<{ id: number; name: string }> }
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const input = (id: string): HTMLInputElement => element<HTMLInputElement>(id)
const select = (id: string): HTMLSelectElement => element<HTMLSelectElement>(id)
let status: Status | null = null
let busy = false

async function send(type: string, payload: Record<string, unknown> = {}): Promise<Status> {
  const result = await chrome.runtime.sendMessage({ type, ...payload })
  if (result?.ok === false) throw new Error(result.error || '操作失败')
  return result as Status
}
function message(value: string, error = false): void { const target = element('message'); target.textContent = value; target.classList.toggle('error', error) }
const phases: Record<string, string> = { disabled: '已停用', signed_out: '未登录', awaiting_boss_page: '等待 BOSS 页面响应', tool_ready: '等待 Agent 工具调用', executing: '正在执行工具', awaiting_retry: '网络或页面异常，等待重试', protocol_unconfirmed: '服务端尚未确认工具协议', session_changed: '账号或执行端已切换' }
function render(next: Status): void {
  status = next
  element('account').textContent = next.authenticated ? `当前账号：${next.username || next.userId}` : '尚未连接账号'
  element('logout').hidden = !next.authenticated
  element('execution').hidden = !next.authenticated
  element('login-form').hidden = next.authenticated
  const fields = [['执行状态', phases[next.phase] || next.phase], ['页面响应', next.online ? '在线' : '离线 / 等待页面'], ['待回报结果', next.pendingResults || 0], ['待同步记录', next.pendingEffects || 0]]
  if (next.lastError) fields.push(['最近错误', next.lastError])
  const list = element('status')
  list.replaceChildren()
  for (const [label, value] of fields) { const dt = document.createElement('dt'); dt.textContent = String(label); const dd = document.createElement('dd'); dd.textContent = String(value); list.append(dt, dd) }
  element<HTMLButtonElement>('disable').disabled = !next.enabled
  const tools = element('tools'); tools.replaceChildren()
  for (const tool of next.tools || []) { const li = document.createElement('li'); li.textContent = `${tool.name}${tool.irreversible ? '（不可撤回）' : ''}`; tools.append(li) }
  if (next.resumes) {
    const choices = select('resume'); choices.replaceChildren(new Option('请选择', ''))
    for (const resume of next.resumes) choices.add(new Option(resume.name || String(resume.id), String(resume.id)))
    choices.value = next.resumeId ? String(next.resumeId) : ''
    input('resume-name').value = next.defaultResumeName || ''
  }
}
async function refresh(): Promise<void> {
  const next = await send('boss.status')
  input('api-base').value = next.apiBase
  render(next.authenticated ? await send('boss.refresh') : next)
  const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' })
  const choices = select('boss-tab'); choices.replaceChildren(new Option('请选择 BOSS 标签页', ''))
  for (const tab of tabs) if (tab.id) choices.add(new Option(`${tab.title || 'BOSS 直聘'}（${tab.id}）`, String(tab.id)))
  choices.value = status?.tabId ? String(status.tabId) : ''
}
async function action(run: () => Promise<void>): Promise<void> {
  if (busy) return
  busy = true
  message('正在处理…')
  try { await run(); message('已更新') } catch (error) { message(error instanceof Error ? error.message : '操作失败', true) }
  finally { busy = false }
}
select('login-method').addEventListener('change', () => {
  const token = select('login-method').value === 'token'
  element('token-fields').hidden = !token; element('password-fields').hidden = token
})
element('login-form').addEventListener('submit', event => {
  event.preventDefault()
  // Request the exact host inside the user's submit gesture. No background auto-grants or arbitrary page HTTP bridge.
  let apiBase: string
  try { apiBase = normalizeApiBase(input('api-base').value) } catch { message('服务地址必须是 HTTPS 源地址；本地联调仅支持 loopback HTTP。', true); return }
  const permission = apiBase === DEFAULT_API_BASE ? Promise.resolve(true) : chrome.permissions.request({ origins: [apiPermissionPattern(apiBase)] })
  void action(async () => {
    if (!await permission) throw new Error('未授权该服务地址')
    const useToken = select('login-method').value === 'token'
    const next = await send(useToken ? 'boss.token' : 'boss.login', { apiBase, token: input('token').value.trim(), email: input('email').value, password: input('password').value })
    input('token').value = ''; input('password').value = ''
    render(next); await refresh()
  })
})
element('logout').addEventListener('click', () => { void action(async () => { render(await send('boss.logout')); input('legacy-disabled').checked = false }) })
element('refresh').addEventListener('click', () => { void action(refresh) })
element('save-resume').addEventListener('click', () => { void action(async () => { render(await send('boss.resume', { resumeId: Number(select('resume').value) || null, defaultResumeName: input('resume-name').value })) }) })
element('enable').addEventListener('click', () => {
  if (!input('legacy-disabled').checked) { message('请先停用旧油猴脚本，再勾选确认。', true); return }
  void action(async () => { render(await send('boss.enable', { tabId: Number(select('boss-tab').value) })) })
})
element('disable').addEventListener('click', () => { void action(async () => { render(await send('boss.disable')) }) })
void refresh().catch(error => message(error instanceof Error ? error.message : '读取状态失败', true))
setInterval(() => { if (!busy) void send('boss.status').then(render).catch(() => undefined) }, 1500)

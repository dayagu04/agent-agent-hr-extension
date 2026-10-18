// 浏览器控制台测试工具 —— 把会话相关的「原子操作」逐个暴露成可手动调用的函数，
// 便于在真实 BOSS 页面逐一验证可行性。挂在 window.aahTools 上。
//
// 用途：开发/测试阶段，在 BOSS 聊天页打开 DevTools 控制台，手动调用
//   aahTools.help()            列出所有工具
//   await aahTools.unread()    读导航未读角标 + 列表未读数
//   aahTools.threads()         列出当前会话列表（公司/岗位/未读/bossId）
//   aahTools.header()          读当前打开会话的头部（公司/岗位/薪资）
//   await aahTools.messages()  读当前打开会话消息（区分 hr/me/system）
//   aahTools.resumes()         列出已配置的简历（发简历时可选哪份）
//   await aahTools.open(公司[, 岗位])     打开指定会话
//   await aahTools.sendResume([简历名])   触发发简历流程（不可撤回！）
//   await aahTools.deleteThread(公司[, 岗位])  删除会话（不可撤回！）
//
// 每个工具都会在控制台用 console.group 打印过程与结果，并返回结构化数据。
// 所有底层动作同时经 diag() 上报后端日志（tag=CHAT/TEST），服务端可查。
import { diag } from './logger'
import { loadConfig } from './config'
import { detectNavUnread } from './nav-unread'
import {
  listThreads,
  openThread,
  deleteThread,
  currentThreadInfo,
  readMessages,
  sendResume,
  completeResumeSend,
  onChatPage,
} from './platforms/boss-chat'

type Json = Record<string, unknown>

function log(title: string, payload?: unknown): void {
  // 控制台分组 + 后端日志双写，用户在页面操作、我方从后端日志复核。
  try {
    // eslint-disable-next-line no-console
    console.log(`%c[aahTools] ${title}`, 'color:#2563eb;font-weight:600', payload ?? '')
  } catch {
    /* ignore */
  }
  diag('TEST', title, payload)
}

function requireChatPage(): boolean {
  if (!onChatPage()) {
    log('✗ 当前不在聊天页，请先到 BOSS 聊天页再测试会话工具')
    return false
  }
  return true
}

/** 读 BOSS 导航栏「消息」未读角标数（feedback #1：不点进去也能知道有无新消息）。 */
function readNavUnreadBadge(): { found: boolean; count: number; raw: string; selector: string } {
  // 与面板共用 nav-unread.ts，避免两套选择器各自失配。
  const r = detectNavUnread()
  return { found: r.count >= 0, count: Math.max(0, r.count), raw: r.probe, selector: r.via }
}

export interface AahTools {
  help(): void
  unread(): { nav: ReturnType<typeof readNavUnreadBadge>; threadsUnread: number; threadsTotal: number }
  threads(): Array<{ company: string; jobTitle: string; unread: boolean; bossId: string }>
  header(): { company: string; jobTitle: string; salary: string; city: string }
  messages(): Promise<Array<{ sender: string; content: string }>>
  resumes(): Array<{ id: string; name: string; isDefault: boolean }>
  open(company: string, jobTitle?: string): 'ok' | 'not-found' | 'failed'
  sendResume(resumeName?: string): Promise<boolean>
  deleteThread(company: string, jobTitle?: string): Promise<'ok' | 'not-found' | 'failed'>
}

const tools: AahTools = {
  help(): void {
    log('可用工具（都在 BOSS 聊天页调用）', {
      'unread()': '导航未读角标 + 列表未读数',
      'threads()': '会话列表（公司/岗位/未读/bossId）',
      'header()': '当前打开会话的头部信息',
      'await messages()': '当前会话消息（hr/me/system）',
      'resumes()': '已配置简历（发哪份）',
      'await open(公司[,岗位])': '打开指定会话',
      'await sendResume([简历名])': '发简历流程（不可撤回）',
      'await deleteThread(公司[,岗位])': '删除会话（不可撤回）',
    })
  },

  unread() {
    const nav = readNavUnreadBadge()
    const list = onChatPage() ? listThreads() : []
    const threadsUnread = list.filter((t) => t.unread).length
    const result = { nav, threadsUnread, threadsTotal: list.length }
    log('未读检测', result)
    if (!nav.found) {
      log('⚠ 导航角标未命中选择器——请把 BOSS 导航「消息」那块的 DOM 结构发我，我据实适配')
    }
    return result
  },

  threads() {
    if (!requireChatPage()) return []
    const list = listThreads().map((t) => ({
      company: t.company,
      jobTitle: t.jobTitle,
      unread: t.unread,
      bossId: t.bossId,
    }))
    log(`会话列表：${list.length} 个（未读 ${list.filter((t) => t.unread).length}）`, list)
    return list
  },

  header() {
    if (!requireChatPage()) return { company: '', jobTitle: '', salary: '', city: '' }
    const info = currentThreadInfo()
    log('当前会话头部', info as unknown as Json)
    return info
  },

  async messages() {
    if (!requireChatPage()) return []
    const msgs = await readMessages()
    const summary = {
      total: msgs.length,
      hr: msgs.filter((m) => m.sender === 'hr').length,
      me: msgs.filter((m) => m.sender === 'me').length,
      system: msgs.filter((m) => m.sender === 'system').length,
    }
    log('会话消息读取', summary)
    // 逐条打印（截断正文，避免刷屏）；sender 分类是重点
    msgs.forEach((m, i) =>
      log(`  [${i}] ${m.sender.toUpperCase()}`, m.content.slice(0, 60)),
    )
    return msgs
  },

  resumes() {
    const cfg = loadConfig()
    const names = cfg.resumeNames || {}
    const def = cfg.defaultSendResumeId ? String(cfg.defaultSendResumeId) : ''
    const list = Object.entries(names).map(([id, name]) => ({
      id,
      name: String(name),
      isDefault: id === def,
    }))
    log(`已配置简历：${list.length} 份（默认发送 id=${def || '未设置'}）`, list)
    if (list.length === 0) {
      log('⚠ 本地无简历名缓存，请先在面板登录并「↻ 同步」')
    }
    return list
  },

  open(company: string, jobTitle = '') {
    if (!requireChatPage()) return 'failed'
    log(`打开会话：公司="${company}" 岗位="${jobTitle}"`)
    const r = openThread(company, jobTitle)
    log(`打开结果：${r}`)
    return r
  },

  async sendResume(resumeName?: string) {
    if (!requireChatPage()) return false
    log(`⚠ 发简历（不可撤回）：${resumeName ? `指定简历="${resumeName}"` : '默认简历流程'}`)
    // 指定简历名时走 completeResumeSend（需先由 HR 卡片或手动点开发简历弹窗）；
    // 不指定时走完整 sendResume（自动点「发简历」按钮 → 选默认简历 → 发送）。
    const r = resumeName ? await completeResumeSend(resumeName) : await sendResume()
    log(`发简历结果：${r ? '✓ 已发送/流程完成' : '✗ 未发送（见上方 CHAT 日志原因）'}`)
    return r
  },

  async deleteThread(company: string, jobTitle = '') {
    if (!requireChatPage()) return 'failed'
    log(`⚠ 删除会话（不可撤回）：公司="${company}" 岗位="${jobTitle}"`)
    const r = await deleteThread(company, jobTitle)
    log(`删除结果：${r}`)
    return r
  },
}

/** 挂到 window，供控制台调用。只在构建产物里暴露一个全局名，不影响宿主页面。 */
export function installTestTools(): void {
  try {
    ;(window as unknown as { aahTools: AahTools }).aahTools = tools
    log('测试工具已就绪：在控制台输入 aahTools.help() 查看用法')
  } catch {
    /* ignore */
  }
}

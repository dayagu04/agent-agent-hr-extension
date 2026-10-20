// 标准工具层 —— 把页面上能做的一件件事封装成 agent 可调用的原子操作。
//
// 约定：
//   - 每个工具 = 一个「页面原子动作」，参数与返回值都是纯数据；
//   - 是否该做由 agent 决策，这里不套产品策略（回不回、发哪份、点同意还是拒绝）；
//   - 每个工具执行后写一行 `tool name=<名字> status=ok|error ...` 日志（不含消息正文/文件名）；
//   - 入口是 remote 命令 `tool.call`，payload: { name, args }；
//     agent 也可以用 `list_tools` 拿到当前可用工具清单。
//
// 注意：send_message / send_resume / delete_thread / click_card 不可撤回。

import { diag } from './logger'
import {
  clickCard,
  currentThreadInfo,
  deleteThread,
  listPendingCardKinds,
  listThreads,
  onChatPage,
  openThread,
  readMessages,
  sendMessageText,
  sendResume,
  type ChatCardKind,
} from './platforms/boss-chat'
import { readSearchFilters, selectSearchFilter } from './search-filters'
import { detectPlatform } from './platforms/factory'
import { loadConfig } from './config'
import { fetchGreeting, recordApplication } from './api'
import { setPendingOpen } from './chat-store'
import type { ApplyOutcome } from './types'

export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface ToolSpec {
  name: string
  description: string
  /** true = 会在页面上产生不可撤回的副作用 */
  irreversible?: boolean
  /** 测试面板里预填的参数示例（也是参数规范的可执行版本） */
  exampleArgs?: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<ToolResult>
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 按 jobId 找卡片。
 *
 * BOSS 首屏未渲染完时，平台回退读 `data-jobid`，拿到的是完整 id 的前 18 位
 * （2026-10-20 实测：短 id 是长 id 的前缀）。所以匹配时允许前缀互认，
 * 否则「上一次扫描拿到的 id 下一次就用不了」。
 */
function findJobCard<T extends { platformJobId: string }>(jobs: T[], jobId: string): T | undefined {
  const exact = jobs.find((j) => j.platformJobId === jobId)
  if (exact) return exact
  if (jobId.length < 12) return undefined
  return jobs.find(
    (j) => j.platformJobId.length >= 12 &&
      (j.platformJobId.startsWith(jobId) || jobId.startsWith(j.platformJobId)),
  )
}

function needChatPage(): ToolResult | null {
  if (onChatPage()) return null
  return { ok: false, error: 'not_chat_page' }
}

const TOOLS: ToolSpec[] = [
  {
    name: 'list_threads',
    description: '列出左侧会话（公司/岗位/未读/bossId）',
    async run() {
      if (needChatPage()) return needChatPage()!
      return { ok: true, data: listThreads() }
    },
  },
  {
    name: 'read_messages',
    description: '读当前打开会话的消息（区分 hr/me/system，卡片带类型）',
    async run() {
      if (needChatPage()) return needChatPage()!
      const info = currentThreadInfo()
      if (!info.company && !info.jobTitle) return { ok: false, error: 'no_open_thread' }
      const messages = await readMessages()
      return { ok: true, data: { thread: info, messages } }
    },
  },
  {
    name: 'list_pending_cards',
    description: '列出当前会话里待处理的交互卡片类型（不点击）',
    async run() {
      if (needChatPage()) return needChatPage()!
      return { ok: true, data: listPendingCardKinds() }
    },
  },
  {
    name: 'open_thread',
    description: '打开指定会话（公司名必填，岗位名可选）；不在聊天页时先跳转聊天页',
    exampleArgs: { company: '', jobTitle: '' },
    async run(args) {
      const company = str(args, 'company')
      if (!company) return { ok: false, error: 'company_required' }
      const jobTitle = str(args, 'jobTitle') || str(args, 'job_title')
      if (!onChatPage()) {
        // 跨页打开：把目标落盘，跳转后由聊天页的 consumePendingOpen 接手
        await setPendingOpen(company, jobTitle)
        setTimeout(() => location.assign('https://www.zhipin.com/web/geek/chat'), 800)
        return { ok: true, data: 'navigating' }
      }
      const r = openThread(company, jobTitle)
      return { ok: r === 'ok', data: r, error: r === 'ok' ? undefined : r }
    },
  },
  {
    name: 'click_card',
    description: '点一张待处理卡片的同意/拒绝（kind=resume_request|location_confirm|contact_exchange，accept=bool；同意索要简历时会走完发简历流程）',
    irreversible: true,
    exampleArgs: { kind: 'resume_request', accept: true, resumeName: '' },
    async run(args) {
      if (needChatPage()) return needChatPage()!
      const kind = str(args, 'kind') as ChatCardKind
      const accept = args.accept !== false
      if (!kind) return { ok: false, error: 'kind_required' }
      // 同意索要简历时可选指定发哪份；不指定则按配置的默认简历
      const ok = await clickCard(kind, accept, { resumeName: str(args, 'resumeName') || null })
      return { ok, error: ok ? undefined : 'card_not_found_or_no_button' }
    },
  },
  {
    name: 'send_message',
    description: '给当前会话发一条文本（不可撤回）',
    irreversible: true,
    exampleArgs: { text: '' },
    async run(args) {
      if (needChatPage()) return needChatPage()!
      const text = str(args, 'text')
      if (!text) return { ok: false, error: 'text_required' }
      const ok = await sendMessageText(text)
      return { ok, error: ok ? undefined : 'send_unconfirmed' }
    },
  },
  {
    name: 'send_resume',
    description: '给当前会话发附件简历（resumeName 可选；不可撤回）',
    irreversible: true,
    exampleArgs: { resumeName: '' },
    async run(args) {
      if (needChatPage()) return needChatPage()!
      const ok = await sendResume(str(args, 'resumeName') || null)
      return { ok, error: ok ? undefined : 'resume_send_failed' }
    },
  },
  {
    name: 'delete_thread',
    description: '删除指定会话（company 必填；不可撤回）',
    irreversible: true,
    exampleArgs: { company: '', jobTitle: '' },
    async run(args) {
      if (needChatPage()) return needChatPage()!
      const company = str(args, 'company')
      if (!company) return { ok: false, error: 'company_required' }
      const r = await deleteThread(company, str(args, 'jobTitle') || str(args, 'job_title'))
      return { ok: r === 'ok', data: r, error: r === 'ok' ? undefined : r }
    },
  },
  {
    name: 'scan_jobs',
    description: '扫描当前职位列表页的岗位（只读；withDetail=true 时读 JD，较慢）',
    exampleArgs: { withDetail: false },
    async run(args) {
      const platform = detectPlatform()
      if (!platform) return { ok: false, error: 'platform_not_supported' }
      const jobs = await platform.scanJobs({ withDetail: args.withDetail === true })
      // 返回体可能很大：只给结构化字段，不带 DOM 引用
      return {
        ok: true,
        data: {
          count: jobs.length,
          jobs: jobs.map((j) => ({
            jobId: j.platformJobId,
            company: j.company,
            title: j.title,
            salary: j.salary || '',
            city: j.city || '',
            jd: j.jd || '',
            jdLength: (j.jd || '').length,
            url: j.url || '',
          })),
        },
      }
    },
  },
  {
    name: 'read_filters',
    description: '读取搜索页筛选条件（分组 + 可选值 + 当前选中）',
    async run() {
      return { ok: true, data: readSearchFilters() }
    },
  },
  {
    name: 'select_filters',
    description: '按「分组 → 选项」点选筛选项（如 工作经验=3-5年），可传多个',
    irreversible: true,
    exampleArgs: { filters: [{ group: '工作经验', option: '3-5年' }] },
    async run(args) {
      const list = Array.isArray(args.filters) ? args.filters : []
      if (!list.length) return { ok: false, error: 'filters_required' }
      const results = []
      for (const item of list) {
        const f = item as Record<string, unknown>
        const group = typeof f.group === 'string' ? f.group : ''
        const option = typeof f.option === 'string' ? f.option : ''
        if (!group || !option) continue
        results.push(await selectSearchFilter(group, option))
      }
      return { ok: results.every((r) => r.status === 'ok'), data: results }
    },
  },
  {
    name: 'get_page_state',
    description: '当前页面状态：网址、是否聊天页、当前打开会话（公司/岗位/薪资/城市）',
    async run() {
      const chat = onChatPage()
      return {
        ok: true,
        data: {
          url: location.href,
          path: location.pathname,
          chat,
          thread: chat ? currentThreadInfo() : null,
        },
      }
    },
  },
  {
    name: 'open_search',
    description: '打开职位搜索页（keyword 必填，cityCode 可选；保留当前筛选条件；会跳转页面）',
    exampleArgs: { keyword: '', cityCode: '' },
    async run(args) {
      const keyword = str(args, 'keyword')
      if (!keyword) return { ok: false, error: 'keyword_required' }
      if (!/zhipin\.com/.test(location.hostname)) return { ok: false, error: 'platform_not_supported' }
      const params = new URLSearchParams(location.search)
      params.delete('page')
      params.set('query', keyword)
      const city = str(args, 'cityCode')
      if (city) params.set('city', city)
      const page = Number(args.page)
      if (Number.isFinite(page) && page > 1) params.set('page', String(Math.floor(page)))
      const url = `https://www.zhipin.com/web/geek/jobs?${params.toString()}`
      // 先让调用方把结果回传成功，再跳转（跳转会销毁当前 JS 上下文）
      setTimeout(() => location.assign(url), 800)
      return { ok: true, data: { url } }
    },
  },
  {
    name: 'read_job_detail',
    description: '读指定岗位的 JD 全文（只切换详情面板，不投递）',
    exampleArgs: { jobId: '' },
    async run(args) {
      const jobId = str(args, 'jobId')
      if (!jobId) return { ok: false, error: 'jobId_required' }
      const platform = detectPlatform()
      if (!platform) return { ok: false, error: 'platform_not_supported' }
      const jobs = await platform.scanJobs()
      const card = findJobCard(jobs, jobId)
      if (!card) return { ok: false, error: 'job_not_found' }
      const reader = (platform as unknown as { readJobDetail?: (c: typeof card) => Promise<string> })
        .readJobDetail
      if (typeof reader !== 'function') return { ok: false, error: 'not_supported' }
      const jd = await reader.call(platform, card)
      return { ok: jd.length > 0, data: { jobId, jd, jdLength: jd.length }, error: jd ? undefined : 'jd_empty' }
    },
  },
  {
    name: 'apply_job',
    description: '对指定岗位点「立即沟通」投递（jobId 必填，不可撤回；会记账）',
    irreversible: true,
    exampleArgs: { jobId: '' },
    async run(args) {
      const jobId = str(args, 'jobId')
      if (!jobId) return { ok: false, error: 'jobId_required' }
      const platform = detectPlatform()
      if (!platform) return { ok: false, error: 'platform_not_supported' }
      const jobs = await platform.scanJobs()
      const card = findJobCard(jobs, jobId)
      if (!card) return { ok: false, error: 'job_not_found' }
      const cfg = loadConfig()
      const raw = await platform.applyJob(card, {
        getGreeting: () => fetchGreeting(cfg, platform.code, card),
      })
      const res = typeof raw === 'boolean'
        ? { outcome: (raw ? 'applied' : 'failed') as ApplyOutcome, message: '', greetingSent: false, alreadyApplied: false }
        : raw
      const outcome = (res.alreadyApplied ? 'applied' : res.outcome) as ApplyOutcome
      try {
        await recordApplication(
          cfg, platform.code, card, 0, outcome, res.message || '', !!res.greetingSent,
          '', new URLSearchParams(location.search).get('query') || '',
        )
      } catch (e) {
        diag('TOOL', `apply_job record status=error error=${(e as Error).name || 'Error'}`)
      }
      return {
        ok: outcome !== 'failed',
        data: { jobId, outcome, messageLength: (res.message || '').length, greetingSent: !!res.greetingSent },
        error: outcome === 'failed' ? 'apply_failed' : undefined,
      }
    },
  },
  {
    name: 'list_tools',
    description: '列出当前可用工具及其参数',
    async run() {
      return { ok: true, data: TOOLS.map((t) => ({ name: t.name, description: t.description, irreversible: !!t.irreversible })) }
    },
  },
]

export function toolCatalog(): Array<{ name: string; description: string; irreversible: boolean }> {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, irreversible: !!t.irreversible }))
}

/** 工具的完整定义（测试面板用：带参数示例） */
export function toolSpecs(): Array<{
  name: string
  description: string
  irreversible: boolean
  exampleArgs: Record<string, unknown>
}> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    irreversible: !!t.irreversible,
    exampleArgs: t.exampleArgs || {},
  }))
}

/** 执行一个工具。未知工具直接报错，不猜。 */
export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) {
    diag('TOOL', `tool name=${name} status=error error=unknown_tool`)
    return { ok: false, error: 'unknown_tool' }
  }
  const started = Date.now()
  try {
    const result = await tool.run(args)
    const detail = result.ok ? summarize(result.data) : `error=${result.error || 'unknown'}`
    diag('TOOL', `tool name=${name} status=${result.ok ? 'ok' : 'error'} ms=${Date.now() - started} ${detail}`)
    return result
  } catch (e) {
    diag('TOOL', `tool name=${name} status=error error=${(e as Error).name || 'Error'} ms=${Date.now() - started}`)
    return { ok: false, error: (e as Error).message || 'tool_failed' }
  }
}

/** 结果摘要（只记数量和字段存在性，不记正文/文件名） */
function summarize(data: unknown): string {
  if (data == null) return 'result=none'
  if (Array.isArray(data)) return `count=${data.length}`
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>
    const bits: string[] = []
    if (typeof o.count === 'number') bits.push(`count=${o.count}`)
    if (Array.isArray(o.messages)) {
      const msgs = o.messages as Array<{ sender?: string }>
      bits.push(`messages=${msgs.length}`)
      for (const k of ['hr', 'me', 'system']) {
        bits.push(`${k}=${msgs.filter((m) => m.sender === k).length}`)
      }
    }
    if (Array.isArray(o.jobs)) bits.push(`jobs=${o.jobs.length}`)
    if (typeof o.thread === 'object' && o.thread) bits.push('thread=1')
    return bits.length ? bits.join(' ') : 'result=object'
  }
  return `result=${String(data).slice(0, 40)}`
}

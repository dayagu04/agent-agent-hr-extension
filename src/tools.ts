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
  listPendingCardsStable,
  listThreads,
  onChatPage,
  openThread,
  readMessages,
  probeRowObject,
  readRowJobInfo,
  sendMessageText,
  sendResumeDetailed,
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
    description: '列出左侧会话（HR 名/公司/未读；岗位名与薪资列表行没有，需 read_thread_header）',
    async run() {
      if (needChatPage()) return needChatPage()!
      // listThreads 的每项带 el（DOM 节点），直接回传会 JSON 序列化失败，
      // 导致 tool result 上传失败、agent 拿不到结果。只回纯数据字段。
      //
      // 字段来源有讲究：列表 DOM 只把「公司 + HR 职务」拼在一起
      // （实测 company="卓越际联科技有限公司人事经理"），岗位名/薪资取不到。
      // 行组件的 Vue boss 对象里有干净的 company/positionName/salary，
      // 与聊天页「无感回填岗位名」用的是同一个 readRowJobInfo。
      const threads = listThreads().map((t) => {
        const info = readRowJobInfo(t.el)
        return {
          hrName: info.hrName || t.name,
          company: info.brandName || t.company,
          jobTitle: info.title || t.jobTitle,
          salary: info.salary || '',
          jobId: info.jobId || '',
          unread: t.unread,
          bossId: t.bossId || '',
        }
      })
      return { ok: true, data: threads }
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
      return { ok: true, data: await listPendingCardsStable() }
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
    exampleArgs: { kind: 'resume_request', accept: true, resumeName: '', resumeIndex: null },
    async run(args) {
      if (needChatPage()) return needChatPage()!
      const kind = str(args, 'kind') as ChatCardKind
      const accept = args.accept !== false
      if (!kind) return { ok: false, error: 'kind_required' }
      // 同意索要简历时可选指定发哪份；不指定则按配置的默认简历
      const ok = await clickCard(kind, accept, {
        resumeName: str(args, 'resumeName') || null,
        resumeIndex: typeof args.resumeIndex === 'number' ? args.resumeIndex : null,
      })
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
    exampleArgs: { resumeName: '', resumeIndex: null },
    async run(args) {
      if (needChatPage()) return needChatPage()!
      const idx = typeof args.resumeIndex === 'number' ? args.resumeIndex : null
      const r = await sendResumeDetailed(str(args, 'resumeName') || null, idx)
      return { ok: r.ok, error: r.ok ? undefined : (r.reason || 'resume_send_failed') }
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
    name: 'probe_overlays',
    description: '读当前可见浮层/弹窗结构（标签链、尺寸、文本长度、是否有 iframe），用于适配选择器',
    async run() {
      const pick = '[class*="dialog"],[class*="modal"],[class*="layer"],[class*="popup"],[class*="overlay"],[role="dialog"]'
      const out: Array<Record<string, unknown>> = []
      for (const el of Array.from(document.querySelectorAll(pick)) as HTMLElement[]) {
        if (el.closest('.aah-root')) continue
        const r = el.getBoundingClientRect()
        if (r.width < 50 || r.height < 30) continue
        const t = (el.textContent || '').replace(/\s/g, '')
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: Array.from(el.classList).slice(0, 3).join('.').slice(0, 60),
          role: el.getAttribute('role') || '',
          size: `${Math.round(r.width)}x${Math.round(r.height)}`,
          textLength: t.length,
          hasFile: /\.(pdf|docx?)$/i.test(t),
          hasTitle: /请选择.{0,6}简历/.test(t),
        })
        if (out.length >= 15) break
      }
      const frames = Array.from(document.querySelectorAll('iframe')).map((f) => {
        const r = f.getBoundingClientRect()
        let sameOrigin = false
        try {
          sameOrigin = !!f.contentDocument
        } catch {
          sameOrigin = false
        }
        return { size: `${Math.round(r.width)}x${Math.round(r.height)}`, sameOrigin }
      })
      return { ok: true, data: { overlays: out, frames } }
    },
  },
  {
    name: 'probe_dom',
    description: '读指定选择器的 DOM 结构（标签/class/role/按钮文案与禁用态/文本长度），用于适配选择器',
    exampleArgs: { selector: '.item-friend', depth: 2 },
    async run(args) {
      const sel = str(args, 'selector') || '.item-friend'
      const rawDepth = Number(args.depth)
      const depth = Number.isFinite(rawDepth) ? Math.max(0, Math.min(4, Math.floor(rawDepth))) : 2
      const shortText = (el: Element): string => {
        if (el.children.length) return ''
        const t = (el.textContent || '').replace(/\s+/g, '').trim()
        return t.length <= 12 ? t : ''
      }
      const walk = (el: Element, d: number): Record<string, unknown> => {
        const node: Record<string, unknown> = {
          tag: el.tagName.toLowerCase(),
          cls: Array.from(el.classList).slice(0, 4).join('.').slice(0, 80),
        }
        const role = el.getAttribute('role')
        if (role) node.role = role
        const aria = el.getAttribute('aria-disabled')
        if (aria) node.ariaDisabled = aria
        let disabled = false
        try {
          disabled = el.matches(':disabled')
        } catch {
          disabled = false
        }
        if (disabled || /disabled|is-disabled|unable/i.test(String((el as HTMLElement).className || ''))) {
          node.disabled = true
        }
        const rect = el.getBoundingClientRect()
        node.rect = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
        node.textLen = (el.textContent || '').replace(/\s/g, '').length
        const t = shortText(el)
        if (t) node.text = t
        if (d > 0 && el.children.length) {
          node.children = Array.from(el.children).slice(0, 8).map((c) => walk(c, d - 1))
        }
        return node
      }
      const roots = Array.from(document.querySelectorAll(sel)).slice(0, 8)
      return { ok: roots.length > 0, data: { selector: sel, count: roots.length, nodes: roots.map((r) => walk(r, depth)) } }
    },
  },
  {
    name: 'probe_row',
    description: '读某一会话行的组件数据结构（键名与短字符串值），用于适配岗位名/薪资字段',
    exampleArgs: { company: '' },
    async run(args) {
      if (needChatPage()) return needChatPage()!
      const company = str(args, 'company')
      const rows = listThreads()
      if (!rows.length) return { ok: false, error: 'no_rows' }
      const target = company
        ? rows.find((t) => (t.company || '').includes(company) || (t.name || '').includes(company))
        : rows[0]
      if (!target) return { ok: false, error: 'row_not_found' }
      const info = probeRowObject(target.el)
      if (!info) return { ok: false, error: 'no_vue_object' }
      return { ok: true, data: { row: { company: target.company, name: target.name }, ...info } }
    },
  },
  {
    name: 'read_thread_header',
    description: '读某一会话的头部信息（HR 名/公司/岗位名/薪资/城市）；不在该会话时会先打开',
    exampleArgs: { company: '', jobTitle: '' },
    async run(args) {
      if (needChatPage()) return needChatPage()!
      const company = str(args, 'company')
      if (!company) return { ok: false, error: 'company_required' }
      const jobTitle = str(args, 'jobTitle') || str(args, 'job_title')
      const current = currentThreadInfo()
      const alreadyOpen = !!current.company && current.company.includes(company)
      if (!alreadyOpen) {
        const r = openThread(company, jobTitle)
        if (r !== 'ok') return { ok: false, error: r }
        await new Promise((res) => setTimeout(res, 900))
      }
      const info = currentThreadInfo()
      return { ok: !!info.company || !!info.jobTitle, data: info, error: info.jobTitle ? undefined : 'header_incomplete' }
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

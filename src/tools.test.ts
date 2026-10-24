import { describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({ diag: vi.fn() }))
vi.mock('./platforms/boss-chat', () => ({
  listThreads: vi.fn(() => [{ company: 'A人事经理', jobTitle: '', name: 'HR', unread: true, bossId: 'x', el: {} }]),
  readRowJobInfo: vi.fn(() => ({ title: 'B', salary: '11-18K', jobId: 'j1', brandName: 'A', hrName: '朱先生' })),
  readMessages: vi.fn(async () => [{ sender: 'hr', content: 'hi' }]),
  currentThreadInfo: vi.fn(() => ({ company: 'A', jobTitle: 'B', salary: '', city: '' })),
  onChatPage: vi.fn(() => true),
  openThread: vi.fn(() => 'ok'),
  clickCard: vi.fn(async () => true),
  listPendingCardKinds: vi.fn(() => [{ kind: 'resume_request', questionLength: 10 }]),
  listPendingCardsStable: vi.fn(async () => [{ kind: 'resume_request', questionLength: 10 }]),
  sendMessageText: vi.fn(async () => true),
  lastDeliveryState: vi.fn(() => 'delivered'),
  sendResume: vi.fn(async () => true),
  sendResumeDetailed: vi.fn(async () => ({ ok: true })),
  deleteThread: vi.fn(async () => 'ok'),
}))
vi.mock('./platforms/factory', () => ({ detectPlatform: vi.fn(() => null) }))
vi.mock('./platforms/boss', () => ({ BossPlatform: vi.fn() }))
vi.mock('./config', () => ({ loadConfig: vi.fn(() => ({})) }))
vi.mock('./orchestrator', () => ({ getOrchestrator: vi.fn(() => ({ isRunning: () => true })) }))
vi.mock('./api', () => ({ fetchGreeting: vi.fn(async () => ''), recordApplication: vi.fn(async () => ({})) }))

import { diag } from './logger'
import { callTool, toolCatalog } from './tools'
import { sendMessageText } from './platforms/boss-chat'
import { detectPlatform } from './platforms/factory'
import { fetchGreeting, recordApplication } from './api'
import { loadConfig } from './config'
import type { ApplyContext } from './platforms/base'
import { BossPlatform } from './platforms/boss'
import { createPageTools } from '../apps/boss-agent/src/page-tools'
import { TOOL_CATALOG, validateToolArgs } from '../apps/boss-agent/src/tools-contract'
import { clickDirect } from './dom-events'
import { installToolExecutionGuard } from './tool-execution-guard'
import { PAGE_RUNTIME_KEY } from '../apps/boss-agent/src/contracts'
import type { InstalledPageTools } from '../apps/boss-agent/src/page'

describe('agent tools', () => {
  it('publishes a catalog that marks irreversible actions', () => {
    const names = toolCatalog().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'read_messages', 'send_message', 'send_resume', 'click_card', 'delete_thread', 'scan_jobs',
      'read_filters', 'select_filters', 'list_tools',
      'get_page_state', 'open_search', 'read_job_detail', 'apply_job', 'probe_overlays', 'probe_dom',
      'read_thread_header', 'probe_row',
    ]))
    expect(toolCatalog().find((t) => t.name === 'send_message')?.irreversible).toBe(true)
    expect(toolCatalog().find((t) => t.name === 'read_messages')?.irreversible).toBe(false)
  })

  it('rejects unknown tools instead of guessing', async () => {
    const r = await callTool('drop_everything', {})
    expect(r.ok).toBe(false)
    expect(r.error).toBe('unknown_tool')
    expect(String((diag as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[1]))
      .toContain('status=error')
  })

  it('requires an explicit text for send_message and never sends empty content', async () => {
    const r = await callTool('send_message', { text: '   ' })
    expect(r).toEqual({ ok: false, error: 'text_required' })
    expect(sendMessageText).not.toHaveBeenCalled()
  })

  it('summarizes results by counts, not content', async () => {
    await callTool('read_messages', {})
    const line = String((diag as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[1])
    expect(line).toContain('name=read_messages status=ok')
    expect(line).toContain('messages=1')
    expect(line).not.toContain('hi')
  })
})

describe('chain tools', () => {
  it('reports the current page state and open thread', async () => {
    const r = await callTool('get_page_state', {})
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ chat: true, thread: { company: 'A', jobTitle: 'B' } })
  })

  it('requires a keyword before navigating to search', async () => {
    const r = await callTool('open_search', {})
    expect(r).toEqual({ ok: false, error: 'keyword_required' })
  })

  it('refuses to read a job detail without a supported platform', async () => {
    const r = await callTool('read_job_detail', { jobId: 'x' })
    expect(r).toEqual({ ok: false, error: 'platform_not_supported' })
  })

  it('requires a job id before applying', async () => {
    const r = await callTool('apply_job', {})
    expect(r).toEqual({ ok: false, error: 'jobId_required' })
  })
})

describe('apply_job', () => {
  const card = { platformJobId: 'j1', title: 'C++', company: 'A', cardElement: null }

  it('applies the requested job and records it like the engine does', async () => {
    const originalConfig = { apiBase: 'https://api.example.test', token: 'account-a', resumeId: 1 }
    const newConfig = { ...originalConfig, token: 'account-b', resumeId: 2 }
    vi.mocked(loadConfig).mockReturnValue(originalConfig as never)
    vi.mocked(fetchGreeting).mockClear()
    vi.mocked(recordApplication).mockClear()
    const applyJob = vi.fn(async (_card: unknown, context?: ApplyContext) => {
      // Account changes while the browser is awaiting BOSS must not reattribute this call.
      vi.mocked(loadConfig).mockReturnValue(newConfig as never)
      await context?.getGreeting?.()
      return { outcome: 'applied', message: '', greetingSent: true, alreadyApplied: false }
    })
    vi.mocked(detectPlatform).mockReturnValue({
      code: 'zhipin',
      scanJobs: async () => [card],
      applyJob,
    } as never)

    try {
      const r = await callTool('apply_job', { jobId: 'j1' })
      expect(r.ok).toBe(true)
      expect(applyJob).toHaveBeenCalledTimes(1)
      expect(vi.mocked(fetchGreeting)).toHaveBeenCalledWith(originalConfig, 'zhipin', card)
      expect(vi.mocked(recordApplication)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(recordApplication).mock.calls[0][0]).toBe(originalConfig)
      expect(vi.mocked(recordApplication).mock.calls[0][4]).toBe('applied')
    } finally { vi.mocked(loadConfig).mockReturnValue({} as never) }
  })

  it('stops before clicking when the job id is not on this page', async () => {
    vi.mocked(detectPlatform).mockReturnValue({
      code: 'zhipin',
      scanJobs: async () => [card],
      applyJob: vi.fn(),
    } as never)

    const r = await callTool('apply_job', { jobId: 'nope' })
    expect(r).toEqual({ ok: false, error: 'job_not_found' })
  })
})

describe('job lookup and bounded scans', () => {
  it('resolves a short job id and reads only the requested detail batch', async () => {
    const readJobDetail = vi.fn(async (_card: { platformJobId: string }) => 'JD 全文')
    vi.mocked(detectPlatform).mockReturnValue({
      code: 'zhipin',
      scanJobs: async () => [{ platformJobId: '628b8fca4a28278e0nx40ti6EFJX', title: 'x', company: 'y' }],
      readJobDetail,
    } as never)

    const r = await callTool('read_job_detail', { jobId: '628b8fca4a28278e0n' })
    expect(r.ok).toBe(true)
    expect(readJobDetail).toHaveBeenCalledTimes(1)

    const cards = Array.from({ length: 13 }, (_, index) => ({ platformJobId: `j${index}`, title: '开发', company: 'A', cardElement: document.createElement('li') }))
    const scanJobs = vi.fn(async () => cards)
    readJobDetail.mockClear().mockImplementation(async () => '职责'.repeat(2000))
    vi.mocked(detectPlatform).mockReturnValue({ code: 'zhipin', scanJobs, readJobDetail } as never)
    const full = await callTool('scan_jobs', {})
    expect(full).toMatchObject({ ok: true, data: { count: 13, total: 13, offset: 0, limit: 13, hasMore: false, nextOffset: null } })
    expect(readJobDetail).not.toHaveBeenCalled()

    const first = await callTool('scan_jobs', { withDetail: true })
    expect(first).toMatchObject({ ok: true, data: { count: 10, total: 13, offset: 0, limit: 10, hasMore: true, nextOffset: 10 } })
    expect(readJobDetail.mock.calls.map(([card]) => card.platformJobId)).toEqual(cards.slice(0, 10).map(card => card.platformJobId))
    expect(scanJobs).toHaveBeenLastCalledWith()
    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(200000)
    expect(JSON.stringify(first)).not.toContain('cardElement')

    readJobDetail.mockClear()
    expect(await callTool('scan_jobs', { withDetail: true, offset: 10, limit: 2 })).toMatchObject({
      ok: true, data: { count: 2, total: 13, offset: 10, limit: 2, hasMore: true, nextOffset: 12, jobs: [{ jobId: 'j10', jdLength: 4000 }, { jobId: 'j11', jdLength: 4000 }] },
    })
    expect(readJobDetail.mock.calls.map(([card]) => card.platformJobId)).toEqual(['j10', 'j11'])
    expect(await callTool('scan_jobs', { withDetail: true, offset: 12, limit: 100 })).toMatchObject({
      ok: true, data: { count: 1, total: 13, offset: 12, limit: 10, hasMore: false, nextOffset: null, jobs: [{ jobId: 'j12' }] },
    })
    readJobDetail.mockClear()
    expect(await callTool('scan_jobs', { withDetail: true, offset: 100 })).toMatchObject({
      ok: true, data: { count: 0, total: 13, offset: 100, limit: 10, hasMore: false, nextOffset: null, jobs: [] },
    })
    expect(readJobDetail).not.toHaveBeenCalled()
    scanJobs.mockClear()
    expect(await callTool('scan_jobs', { limit: 0 })).toEqual({ ok: false, error: 'invalid_arguments' })
    expect(scanJobs).not.toHaveBeenCalled()
  })
})

describe('tool results must be JSON-serializable', () => {
  it('list_threads strips DOM references and prefers the row Vue data', async () => {
    const r = await callTool('list_threads', {})
    expect(() => JSON.stringify(r)).not.toThrow()
    // 公司/岗位来自行组件数据，不再用 DOM 里「公司+HR职务」的拼接文本
    expect(r.data).toEqual([{
      hrName: '朱先生', company: 'A', jobTitle: 'B', salary: '11-18K', jobId: 'j1',
      unread: true, bossId: 'x',
    }])
  })
})

describe('send_message preconditions', () => {
  it('refuses with no_open_thread before touching the page', async () => {
    const { currentThreadInfo, sendMessageText } = await import('./platforms/boss-chat')
    vi.mocked(currentThreadInfo).mockReturnValueOnce({ company: '', hrName: '', jobTitle: '', salary: '', city: '' } as never)
    vi.mocked(sendMessageText).mockClear()

    const r = await callTool('send_message', { text: '你好' })
    expect(r).toEqual({ ok: false, error: 'no_open_thread' })
    expect(sendMessageText).not.toHaveBeenCalled()
  })
})

describe('reload_page', () => {
  it('refuses while auto-apply is running unless forced', async () => {
    expect(await callTool('reload_page', {})).toEqual({ ok: false, error: 'orchestrator_running' })
  })
})

describe('MV3 page boundary', () => {
  it('publishes function schemas and rejects malformed arguments before accessing page tools', async () => {
    expect(TOOL_CATALOG.map((tool) => tool.name).sort()).toEqual(toolCatalog().map((tool) => tool.name).sort())
    expect(TOOL_CATALOG.every((tool) => tool.parameters.type === 'object' && tool.parameters.additionalProperties === false)).toBe(true)
    for (const [name, args, error] of [
      ['unknown', {}, 'unknown_tool'],
      ['send_message', [], 'invalid_arguments'],
      ['send_message', { text: true }, 'invalid_arguments'],
      ['send_message', { text: '  ' }, 'text_required'],
      ['click_card', { kind: 'resume_request' }, 'invalid_arguments'],
      ['click_card', { kind: 'unknown', accept: true }, 'invalid_arguments'],
      ['select_filters', { filters: [{ group: '经验' }] }, 'invalid_arguments'],
      ['send_resume', { resumeIndex: -1 }, 'invalid_arguments'],
      ['open_search', { keyword: '开发', page: 1.1 }, 'invalid_arguments'],
      ['scan_jobs', { offset: -1 }, 'invalid_arguments'],
      ['scan_jobs', { limit: 0 }, 'invalid_arguments'],
      ['reload_page', { force: 'false' }, 'invalid_arguments'],
    ] as const) {
      expect(validateToolArgs(name, args)).toEqual({ ok: false, error })
    }
    expect(validateToolArgs('scan_jobs', { withDetail: true, offset: 10, limit: 5 })).toEqual({ ok: true })
    const location = { protocol: 'https:', hostname: 'www.zhipin.com' }
    vi.stubGlobal('location', location)
    vi.mocked(sendMessageText).mockClear()
    try {
      expect(await createPageTools().run({ commandKey: 'invalid', name: 'send_message', args: { text: false } })).toEqual({ result: { ok: false, error: 'invalid_arguments' } })
      expect(sendMessageText).not.toHaveBeenCalled()
      const button = document.createElement('button')
      const click = vi.fn()
      button.addEventListener('click', click)
      installToolExecutionGuard(() => { throw new Error('page_execution_cancelled') })
      expect(() => clickDirect(button)).toThrow('page_execution_cancelled')
      expect(click).not.toHaveBeenCalled()
    } finally { installToolExecutionGuard(null); vi.unstubAllGlobals() }
  })

  it('returns durable effects, deduplicates document commands and preserves cancellation uncertainty', async () => {
    const location = { protocol: 'https:', hostname: 'www.zhipin.com', href: 'https://www.zhipin.com/web/geek/jobs', pathname: '/web/geek/jobs', search: '?query=开发', assign: vi.fn(), reload: vi.fn() }
    vi.stubGlobal('location', location)
    const applyJob = vi.fn(async () => ({ outcome: 'applied', greetingSent: true }))
    const scanJobs = vi.fn(async () => [{ platformJobId: 'j1', title: '开发', company: 'A', salary: '10-20K', city: '上海', description: '职责' }])
    vi.mocked(BossPlatform).mockImplementation(function () { return { code: 'zhipin', applyJob, scanJobs } as never })
    try {
      await import('../apps/boss-agent/src/page')
      const page = (globalThis as unknown as Record<typeof PAGE_RUNTIME_KEY, InstalledPageTools>)[PAGE_RUNTIME_KEY]
      const invocation = { commandKey: 'boss:123', name: 'apply_job', args: { jobId: 'j1' }, context: { greeting: '你好' } }
      expect(await page.prepare(invocation)).toMatchObject({ ok: true, data: { job: { platformJobId: 'j1', salary: '10-20K', city: '上海' } } })
      const result = await page.run(invocation)
      expect(result).toMatchObject({ result: { ok: true }, effects: [{ kind: 'application', payload: { platform: 'zhipin', platform_job_id: 'j1', outcome: 'applied', greeting_sent: true } }] })
      expect(await page.run(invocation)).toEqual(result)
      expect(applyJob).toHaveBeenCalledTimes(1)
      expect(await page.run({ ...invocation, args: { jobId: 'other' } })).toEqual({ result: { ok: false, error: 'command_key_conflict' } })
      const navigation = await page.run({ commandKey: 'navigate', name: 'open_search', args: { keyword: '客服', page: 2 } })
      expect(navigation.effects).toEqual([{ kind: 'navigate', url: 'https://www.zhipin.com/web/geek/jobs?query=%E5%AE%A2%E6%9C%8D&page=2' }])
      expect(location.assign).not.toHaveBeenCalled()
      expect(location.reload).not.toHaveBeenCalled()
      const { deleteThread } = await import('./platforms/boss-chat')
      vi.mocked(deleteThread).mockImplementationOnce(async (_company, _jobTitle, _identity, afterDeleted) => {
        await afterDeleted?.({ company: 'A', jobTitle: '开发', encryptJobId: 'actual-job-id', bossId: 'actual-boss-id' })
        return 'ok'
      })
      expect(await page.run({ commandKey: 'delete', name: 'delete_thread', args: { company: 'A' } })).toMatchObject({
        effects: [{ kind: 'conversation_deleted', payload: { company: 'A', job_title: '开发', encrypt_job_id: 'actual-job-id' } }],
      })
      const epoch = page.lifecycleEpoch()
      vi.mocked(sendMessageText).mockImplementationOnce(async () => { document.dispatchEvent(new Event('freeze')); return true })
      expect(await page.run({ commandKey: 'cancelled', name: 'send_message', args: { text: '你好' } })).toEqual({ result: { ok: false, error: 'reconciliation_required' } })
      expect(page.lifecycleEpoch()).toBe(epoch + 1)
      document.dispatchEvent(new Event('freeze')) // A queued run must also be fenced when no lease has started yet.
      expect(page.lifecycleEpoch()).toBe(epoch + 2)
    } finally { vi.unstubAllGlobals() }
  })
})

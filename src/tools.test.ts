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
  sendMessageText: vi.fn(async () => true),
  sendResume: vi.fn(async () => true),
  sendResumeDetailed: vi.fn(async () => ({ ok: true })),
  deleteThread: vi.fn(async () => 'ok'),
}))
vi.mock('./platforms/factory', () => ({ detectPlatform: vi.fn(() => null) }))
vi.mock('./config', () => ({ loadConfig: vi.fn(() => ({})) }))
vi.mock('./api', () => ({ fetchGreeting: vi.fn(async () => ''), recordApplication: vi.fn(async () => ({})) }))

import { diag } from './logger'
import { callTool, toolCatalog } from './tools'
import { sendMessageText } from './platforms/boss-chat'
import { detectPlatform } from './platforms/factory'
import { recordApplication } from './api'

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
    const applyJob = vi.fn(async () => ({
      outcome: 'applied', message: '', greetingSent: true, alreadyApplied: false,
    }))
    vi.mocked(detectPlatform).mockReturnValue({
      code: 'zhipin',
      scanJobs: async () => [card],
      applyJob,
    } as never)

    const r = await callTool('apply_job', { jobId: 'j1' })

    expect(r.ok).toBe(true)
    expect(applyJob).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordApplication)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordApplication).mock.calls[0][4]).toBe('applied')
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

describe('job id lookup tolerance', () => {
  it('accepts the short data-jobid when the full encrypted id is known', async () => {
    const readJobDetail = vi.fn(async () => 'JD 全文')
    vi.mocked(detectPlatform).mockReturnValue({
      code: 'zhipin',
      scanJobs: async () => [{ platformJobId: '628b8fca4a28278e0nx40ti6EFJX', title: 'x', company: 'y' }],
      readJobDetail,
    } as never)

    const r = await callTool('read_job_detail', { jobId: '628b8fca4a28278e0n' })
    expect(r.ok).toBe(true)
    expect(readJobDetail).toHaveBeenCalledTimes(1)
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

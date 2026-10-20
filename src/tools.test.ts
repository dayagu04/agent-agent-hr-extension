import { describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({ diag: vi.fn() }))
vi.mock('./platforms/boss-chat', () => ({
  listThreads: vi.fn(() => [{ company: 'A', jobTitle: 'B', unread: true, bossId: 'x' }]),
  readMessages: vi.fn(async () => [{ sender: 'hr', content: 'hi' }]),
  currentThreadInfo: vi.fn(() => ({ company: 'A', jobTitle: 'B', salary: '', city: '' })),
  onChatPage: vi.fn(() => true),
  openThread: vi.fn(() => 'ok'),
  clickCard: vi.fn(async () => true),
  listPendingCardKinds: vi.fn(() => [{ kind: 'resume_request', questionLength: 10 }]),
  sendMessageText: vi.fn(async () => true),
  sendResume: vi.fn(async () => true),
  deleteThread: vi.fn(async () => 'ok'),
}))
vi.mock('./platforms/factory', () => ({ detectPlatform: vi.fn(() => null) }))
vi.mock('./config', () => ({ loadConfig: vi.fn(() => ({})) }))
vi.mock('./api', () => ({ fetchGreeting: vi.fn(async () => ''), recordApplication: vi.fn(async () => ({})) }))

import { diag } from './logger'
import { callTool, toolCatalog } from './tools'
import { sendMessageText } from './platforms/boss-chat'

describe('agent tools', () => {
  it('publishes a catalog that marks irreversible actions', () => {
    const names = toolCatalog().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'read_messages', 'send_message', 'send_resume', 'click_card', 'delete_thread', 'scan_jobs',
      'read_filters', 'select_filters', 'list_tools',
      'get_page_state', 'open_search', 'read_job_detail', 'apply_job',
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

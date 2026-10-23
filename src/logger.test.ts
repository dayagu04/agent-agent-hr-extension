import { beforeEach, describe, expect, it, vi } from 'vitest'

const { request } = vi.hoisted(() => ({ request: vi.fn().mockResolvedValue({ status: 200 }) }))
vi.mock('./platform-bridge', () => ({ network: { request } }))
vi.mock('./config', () => ({ loadConfig: () => ({ apiBase: 'https://example.test', token: 'test' }), isConfigReady: () => true }))

import { diag, flushLogs, setLogRunId } from './logger'

beforeEach(() => {
  request.mockReset()
  request.mockResolvedValue({ status: 200 })
})

describe('plugin log grouping metadata', () => {
  it('captures the execution round and event time before uploading a batch', async () => {
    setLogRunId('run-1')
    diag('ORCH', 'started')
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    const payload = JSON.parse(request.mock.calls[0][0].data)
    expect(payload.batch_id).toMatch(/^b-[a-z0-9-]+$/)
    // 服务端日志文件按版本号标注来源，缺了就无法区分新旧构建的现场。
    expect(payload.plugin_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(payload.logs[0].run_id).toBe('run-1')
    expect(payload.logs[0].event_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    setLogRunId('')
  })

  it('force flushes a sub-threshold tail immediately after a recent upload', async () => {
    diag('ORCH', 'first')
    await flushLogs({ force: true })
    expect(request).toHaveBeenCalledTimes(1)

    diag('ORCH', 'terminal tail')
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)

    await flushLogs({ force: true })
    expect(request).toHaveBeenCalledTimes(2)
    const payload = JSON.parse(request.mock.calls[1][0].data)
    expect(payload.logs.map((item: { message: string }) => item.message)).toContain('terminal tail')
  })

  it('queues a force request behind an in-flight batch without losing the tail', async () => {
    let resolveFirst!: (value: { status: number }) => void
    request.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve
    }))
    request.mockResolvedValue({ status: 200 })

    diag('ORCH', 'in flight')
    const first = flushLogs({ force: true })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    diag('ORCH', 'arrived during upload')
    const queued = flushLogs({ force: true })

    resolveFirst({ status: 200 })
    await Promise.all([first, queued])

    expect(request).toHaveBeenCalledTimes(2)
    const tail = JSON.parse(request.mock.calls[1][0].data)
    expect(tail.logs.map((item: { message: string }) => item.message)).toContain('arrived during upload')
  })

  it('retries an uncertain batch with the same idempotency key', async () => {
    request.mockRejectedValueOnce(new Error('timeout'))
    request.mockResolvedValueOnce({ status: 200 })

    diag('ORCH', 'retry me')
    await flushLogs({ force: true })
    await flushLogs({ force: true })

    expect(request).toHaveBeenCalledTimes(2)
    const first = JSON.parse(request.mock.calls[0][0].data)
    const retry = JSON.parse(request.mock.calls[1][0].data)
    expect(retry.batch_id).toBe(first.batch_id)
    expect(retry.logs).toEqual(first.logs)
  })

  it('treats a forced flush with no buffered work as a no-op', async () => {
    await flushLogs({ force: true })
    await Promise.resolve()

    expect(request).not.toHaveBeenCalled()
  })
})

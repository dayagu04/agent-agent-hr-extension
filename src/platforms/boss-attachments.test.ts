import { afterEach, describe, expect, it, vi } from 'vitest'

const { diag } = vi.hoisted(() => ({ diag: vi.fn() }))
vi.mock('../logger', () => ({ diag }))
vi.mock('../platform-bridge', () => ({ storage: { get: vi.fn(), set: vi.fn() } }))

import { probeBossAttachments } from './boss-attachments'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountVue(root: any): void {
  const el = document.createElement('div')
  document.body.appendChild(el)
  // BOSS 是 Vue 2：任意节点上的 __vue__ 都能拿到 $root
  ;(el as unknown as { __vue__: unknown }).__vue__ = { $root: root }
}

afterEach(() => {
  document.body.innerHTML = ''
  diag.mockClear()
})

describe('probeBossAttachments (no clicks)', () => {
  it('finds the attachment list in the page store and returns names and ids', () => {
    mountVue({
      $store: {
        state: {
          chat: { threads: [{ name: '某公司' }] },
          resume: {
            attachList: [
              { resumeId: 'r1', fileName: '蔡韬的简历-agent.pdf', size: 263700 },
              { resumeId: 'r2', fileName: '261011.pdf', size: 313200 },
            ],
          },
        },
      },
      $children: [],
    })

    const snap = probeBossAttachments()
    expect(snap?.via).toBe('probe:store')
    expect(snap?.items).toEqual([
      { name: '蔡韬的简历-agent.pdf', id: 'r1' },
      { name: '261011.pdf', id: 'r2' },
    ])
    // 日志只有字段名和数量，没有文件名
    const line = String(diag.mock.calls.at(-1)?.[1])
    expect(line).toContain('count=2')
    expect(line).toContain('path=store.resume.attachList')
    expect(line).not.toContain('261011')
  })

  it('falls back to the component tree when the store has no attachments', () => {
    mountVue({
      $store: { state: { user: { id: 1 } } },
      $data: {},
      $children: [
        { $options: { name: 'ResumeSender' }, $data: { files: [{ id: 7, name: 'a.pdf' }] }, $children: [] },
      ],
    })

    const snap = probeBossAttachments()
    expect(snap?.via).toBe('probe:component')
    expect(snap?.items).toEqual([{ name: 'a.pdf', id: '7' }])
  })

  it('returns null (and logs why) when BOSS has not loaded the list', () => {
    mountVue({ $store: { state: { user: { id: 1 } } }, $data: {}, $children: [] })

    expect(probeBossAttachments()).toBeNull()
    expect(String(diag.mock.calls.at(-1)?.[1])).toMatch(/^attach_probe status=none store=1 components=1/)
  })

  it('does not mistake a chat message article (picUrl/url/title) for the attachment list', () => {
    // 2026-10-20 实测误判：ChatMessage.props.message.articles 被当成 1 份附件
    mountVue({
      $store: { state: { user: { id: 1 } } },
      $data: {},
      $children: [
        {
          $options: { name: 'ChatMessage' },
          $props: {
            message: {
              articles: [
                {
                  templateId: 1,
                  title: '附件简历',
                  picUrl: 'https://img.example.com/a/b.png',
                  url: 'https://www.zhipin.com/web/geek/resume/detail.pdf',
                  bottomText: '查看',
                },
              ],
            },
          },
          $children: [],
        },
      ],
    })

    expect(probeBossAttachments()).toBeNull()
    expect(String(diag.mock.calls.at(-1)?.[1])).toMatch(/^attach_probe status=none/)
  })

  it('accepts a single attachment whose field is plainly a file name even without an id', () => {
    mountVue({
      $store: { state: { resume: { list: [{ fileName: '蔡韬的简历-agent.pdf' }] } } },
      $data: {},
      $children: [],
    })

    expect(probeBossAttachments()?.items).toEqual([{ name: '蔡韬的简历-agent.pdf', id: '' }])
  })
})

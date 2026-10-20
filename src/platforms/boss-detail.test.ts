import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ diag: vi.fn() }))

import { BossPlatform } from './boss'

describe('reading a job JD from the detail pane', () => {
  it('drops the anti-scraping inline CSS and keeps the real description', async () => {
    document.body.innerHTML = `
      <div class="job-detail-box">
        <style>.anNMcHFn{display:inline-block;font-size:0!important}</style>
        <h3>行政班 早九晚六</h3>
        <div class="job-sec-text">岗位职责：负责日常行政事务与文件整理。</div>
        <button>立即沟通</button>
      </div>`
    const platform = new BossPlatform()
    // readDetailJd 是内部实现，测试直接调它（只读，不点击）
    const jd = await (platform as unknown as { readDetailJd(): string }).readDetailJd()

    expect(jd).toContain('岗位职责')
    expect(jd).not.toContain('display:inline-block')
    expect(jd).not.toContain('立即沟通')
    expect(jd.length).toBeLessThan(200)
  })
})

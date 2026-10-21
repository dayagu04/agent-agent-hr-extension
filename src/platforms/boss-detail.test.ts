import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ diag: vi.fn() }))

import { BossPlatform } from './boss'

function rect(width: number) {
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, width, height: 20, toJSON: () => ({}) }
}

describe('reading a job JD from the detail pane', () => {
  it('drops the anti-scraping inline CSS and keeps the real description', async () => {
    document.body.innerHTML = `
      <div class="job-detail-box">
        <style>.anNMcHFn{display:inline-block;font-size:0!important}</style>
        <h3>行政班 早九晚六</h3>
        <div class="job-sec-text">岗位职责：负责日常行政事务与文件整理。</div>
        <button>立即沟通</button>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*'))) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(100))
    }
    const platform = new BossPlatform()
    const jd = await (platform as unknown as { readDetailJd(): string }).readDetailJd()

    expect(jd).toContain('岗位职责')
    expect(jd).not.toContain('display:inline-block')
    expect(jd).not.toContain('立即沟通')
  })

  it('removes zero-size watermark spans (kanzhun / BOSS直聘) mixed into the text', async () => {
    // 2026-10-21 probe_dom 实测：p.desc 里夹着随机 class 的 0 宽 span
    document.body.innerHTML = `
      <div class="job-detail-box">
        <p class="desc">电话客服<span class="jGGisttdfwC">kanzhun</span>坐班<span class="rwKxDXYPc">BOSS直聘</span>不含销售<span class="PYrtrhdnmjFr">直聘</span></p>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*'))) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(el.tagName === 'SPAN' ? 0 : 300))
    }
    const platform = new BossPlatform()
    const jd = await (platform as unknown as { readDetailJd(): string }).readDetailJd()

    expect(jd).toBe('电话客服坐班不含销售')
    // 活 DOM 上的临时标记必须清掉，不能污染页面
    expect(document.querySelector('[data-aah-hidden]')).toBeNull()
  })
})

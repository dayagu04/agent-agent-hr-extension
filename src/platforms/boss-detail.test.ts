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

  it('also removes 0.1px-wide watermark spans (rounds to 0 but is not 0)', async () => {
    // 2026-10-23 实测：反爬 CSS 用 width:0.1px，旧判断 width === 0 漏掉
    document.body.innerHTML = `
      <div class="job-detail-box">
        <p class="desc">小白<span class="pBYPaWST">kanzhun</span>首选<span class="BTiFBHrXDAe">来自BOSS直聘</span>带薪培训</p>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const w = el.tagName === 'SPAN' ? 0.1 : 300
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ ...rect(w), height: el.tagName === 'SPAN' ? 0.1 : 20 })
    }
    const platform = new BossPlatform()
    const jd = await (platform as unknown as { readDetailJd(): string }).readDetailJd()

    expect(jd).toBe('小白首选带薪培训')
  })
})

describe('JD scope', () => {
  it('reads only p.desc, not the HR card, address or SEO links in the same panel', async () => {
    // 2026-10-23 probe_dom 实测：.job-detail-body 下 h3.title + p.desc + .job-boss-info + .job-address
    document.body.innerHTML = `
      <div class="job-detail-box">
        <div class="job-detail-header"><div class="job-header-info">纯客服 5-8K</div></div>
        <div class="job-detail-body">
          <h3 class="title">职位描述</h3>
          <p class="desc">小白首选，带薪培训</p>
          <div class="job-boss-info">曹女士 刚刚活跃 去App与BOSS随时沟通</div>
          <div class="job-address">工作地址 合肥蜀山区</div>
        </div>
        <div class="seo">合肥保洁招聘合肥BOSS直聘招聘</div>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*'))) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(300))
    }
    const platform = new BossPlatform()
    const jd = await (platform as unknown as { readDetailJd(): string }).readDetailJd()

    expect(jd).toBe('小白首选，带薪培训')
  })
})

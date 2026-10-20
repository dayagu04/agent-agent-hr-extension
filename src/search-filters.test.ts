import { afterEach, describe, expect, it, vi } from 'vitest'

const { diag } = vi.hoisted(() => ({ diag: vi.fn() }))
vi.mock('./logger', () => ({ diag }))

import { probeSearchFiltersOnce, readSearchFilters, selectSearchFilter } from './search-filters'

function visibleAll(): void {
  for (const el of Array.from(document.querySelectorAll('*'))) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 60, bottom: 20, width: 60, height: 20, toJSON: () => ({}),
    })
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  diag.mockClear()
})

describe('search filters (read only)', () => {
  it('reads filter groups and notice which options carry URL params', () => {
    document.body.innerHTML = `
      <div class="condition-box">
        <div class="row"><span>城市</span>
          <a href="/web/geek/jobs?query=x&city=101010100" class="active">合肥</a>
          <a href="/web/geek/jobs?query=x&city=101020100">上海</a>
        </div>
        <div class="row"><span>工作经验</span>
          <span role="option">1-3年</span>
          <span role="option">3-5年</span>
        </div>
        <div class="row"><span>薪资待遇</span>
          <span role="option">10-15K</span>
          <span role="option">15-20K</span>
        </div>
      </div>`
    visibleAll()

    const groups = readSearchFilters()
    expect(groups.map((g) => g.name)).toEqual(['城市', '薪资待遇', '工作经验'])
    const city = groups[0]
    expect(city.options.map((o) => o.text)).toEqual(['合肥', '上海'])
    expect(city.options[0].href).toContain('city=101010100')
    expect(city.options[0].selected).toBe(true)
    expect(city.options[1].selected).toBe(false)
    // 不带 href 的组说明只能靠点击，没法用 URL 参数设定
    expect(groups[1].options.every((o) => !o.href)).toBe(true)
  })

  it('logs one summary line per URL, without page copy', () => {
    document.body.innerHTML = `
      <div class="condition-box">
        <div class="row"><span>城市</span>
          <a href="?city=1" class="active">合肥</a><a href="?city=2">上海</a></div>
      </div>`
    visibleAll()
    window.history.replaceState({}, '', '/web/geek/jobs?query=python&city=1')

    probeSearchFiltersOnce('test')
    const line = String(diag.mock.calls.at(-1)?.[1])
    expect(line).toContain('status=found')
    expect(line).toContain('城市:2opt,href=city,sel=1')
    expect(line).toContain('params=city')

    // 同一 URL 不重复刷屏
    probeSearchFiltersOnce('test')
    expect(diag).toHaveBeenCalledTimes(1)
  })

  it('says plainly when the filter bar is not recognized', () => {
    document.body.innerHTML = `<div class="whatever">职位</div>`
    visibleAll()
    window.history.replaceState({}, '', '/web/geek/jobs?query=python')

    probeSearchFiltersOnce('test')
    const line = String(diag.mock.calls.at(-1)?.[1])
    expect(line).toContain('status=none')
    expect(line).toContain('params=-')
  })
})

describe('selecting a filter (click → panel → option)', () => {
  function rects(): void {
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if ((el as HTMLElement).getBoundingClientRect().width > 0) continue
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, top: 0, left: 0, right: 60, bottom: 20, width: 60, height: 20, toJSON: () => ({}),
      })
    }
  }

  it('opens the group panel and clicks the exact option', async () => {
    document.body.innerHTML = `
      <div class="filter-bar"><span class="label">工作经验</span></div>`
    rects()
    const label = document.querySelector('.label') as HTMLElement
    label.addEventListener('click', () => {
      const panel = document.createElement('div')
      panel.className = 'dropdown-panel'
      panel.innerHTML = '<span>1-3年</span><span>3-5年</span>'
      document.body.appendChild(panel)
      rects()
    })
    const clicked: string[] = []
    document.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).textContent || ''
      if (t === '3-5年') clicked.push(t)
    })

    const r = await selectSearchFilter('工作经验', '3-5年')
    expect(r.status).toBe('ok')
    expect(clicked).toEqual(['3-5年'])
  })

  it('stops and says why when the group label is missing', async () => {
    document.body.innerHTML = `<div class="filter-bar"><span>城市</span></div>`
    rects()
    const r = await selectSearchFilter('工作经验', '3-5年')
    expect(r.status).toBe('no_trigger')
    expect(String(diag.mock.calls.at(-1)?.[1])).toContain('status=no_trigger')
  })
})

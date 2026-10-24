import { afterEach, describe, expect, it, vi } from 'vitest'

// Page contracts do not exercise the legacy network logger or its unauthenticated retry queue.
vi.mock('../logger', () => ({ diag: vi.fn() }))

import {
  classifyCard,
  clickCard,
  completeResumeSend,
  countResumeSentMarks,
  currentThreadId,
  currentThreadInfo,
  findDialogButton,
  findResumeDialog,
  isActionCardAllowed,
  isContactCardAllowed,
  listPendingCardKinds,
  listResumeOptions,
  openThread,
  openThreadConfirmed,
  readMessages,
  selectResumeRowByIndex,
  resumeDialogKind,
  selectResumeInDialog,
  threadRowMatchesText,
} from './boss-chat'
import { normalizeAgentPolicy } from '../contact-policy'
import { installToolExecutionGuard } from '../tool-execution-guard'

describe('BOSS interaction card classification', () => {
  it('does not classify phone interview cards as contact exchange', () => {
    expect(classifyCard('电话面试时间方便吗？')).toBe('unknown')
    expect(classifyCard('电话沟通一下工作内容')).toBe('unknown')
    expect(classifyCard('请留下手机号')).toBe('contact_exchange')
    expect(classifyCard('方便交换微信吗？')).toBe('contact_exchange')
  })

  it('enforces backend allowed channels for every contact card', () => {
    const policy = normalizeAgentPolicy(
      { mode: 'full_auto' },
      { channels: ['phone', 'wechat', 'email'] },
    )
    const decision = {
      provided: true,
      allowed: true,
      channel: null,
      channels: ['phone' as const],
      actionId: null,
    }
    expect(isContactCardAllowed(decision, 'phone', policy)).toBe(true)
    expect(isContactCardAllowed(decision, 'wechat', policy)).toBe(false)
    expect(isContactCardAllowed({ ...decision, channels: [] }, 'phone', policy)).toBe(false)
  })

  it('blocks resume and location card side effects when their actions are denied', () => {
    const policy = normalizeAgentPolicy(
      {
        mode: 'full_auto',
        actions: { send_resume: 'deny', answer_city: 'allow', negotiate_interview: 'allow' },
      },
      { channels: [] },
    )
    expect(isActionCardAllowed(policy, 'resume_request')).toBe(false)
    expect(isActionCardAllowed(policy, 'location_confirm')).toBe(true)

    const locationDenied = normalizeAgentPolicy(
      {
        mode: 'full_auto',
        actions: { answer_city: 'allow', negotiate_interview: 'ask_once' },
      },
      { channels: [] },
    )
    expect(isActionCardAllowed(locationDenied, 'location_confirm')).toBe(false)
  })
})

describe('BOSS resume picker DOM handling', () => {
  function setRect(el: Element, width: number, height: number): void {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    })
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('finds the visible resume picker and its send button through a portal dialog', () => {
    document.body.innerHTML = `
      <div role="dialog" class="upload-resume-dialog">
        <div class="dialog-header">请选择要发送的简历</div>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const button = dialog.querySelector('button') as HTMLElement
    setRect(dialog, 720, 398)
    setRect(button, 100, 40)

    expect(findResumeDialog()).toBe(dialog)
    expect(findDialogButton(dialog, /^(发送|确定)$/)).toBe(button)
  })

  it('keeps recognizing a picker that also offers an upload-resume entry', () => {
    document.body.innerHTML = `
      <div role="dialog" class="dialog-wrap active">
        <div class="dialog-header">请选择要发送的简历</div>
        <button type="button">上传简历</button>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const header = dialog.querySelector('.dialog-header') as HTMLElement
    setRect(dialog, 720, 398)
    setRect(header, 240, 40)

    expect(findResumeDialog()).toBe(dialog)
  })

  it('returns the actionable ancestor and preserves its disabled state', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <button type="button" disabled><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    const span = dialog.querySelector('span') as HTMLElement
    setRect(dialog, 720, 398)
    setRect(button, 100, 40)
    setRect(span, 80, 24)

    expect(findDialogButton(dialog, /^发送$/)).toBe(button)
    expect(button.disabled).toBe(true)
  })

  it('does not activate a disabled input submit control', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <input type="submit" disabled value="发送">
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const submit = dialog.querySelector('input') as HTMLInputElement
    setRect(dialog, 720, 398)
    setRect(submit, 100, 40)
    const clicks = vi.fn()
    submit.addEventListener('click', clicks)

    const result = completeResumeSend(null)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(false)
    expect(clicks).not.toHaveBeenCalled()
  })

  it('honors disabled fieldset inheritance before dispatching a synthetic click', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <fieldset disabled><button type="button">发送</button></fieldset>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    setRect(dialog, 720, 398)
    setRect(button, 100, 40)
    const clicks = vi.fn()
    button.addEventListener('click', clicks)

    const result = completeResumeSend(null)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(false)
    expect(clicks).not.toHaveBeenCalled()
  })

  it('finds an icon-only action by its accessible label', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <button type="button" aria-label="确认发送"><svg></svg></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    setRect(dialog, 720, 398)
    setRect(button, 100, 40)

    expect(findDialogButton(dialog, /^确认发送$/)).toBe(button)
  })

  it('selects the configured resume before a disabled send button can become enabled', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item"><input type="radio" name="resume"><span>候选人简历 C++.pdf</span></label>
        <button type="button" disabled><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const row = dialog.querySelector('label') as HTMLElement
    const name = dialog.querySelector('label span') as HTMLElement
    const input = dialog.querySelector('input') as HTMLInputElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    for (const el of [dialog, row, name, input, button, button.querySelector('span')!]) setRect(el, 100, 40)
    row.addEventListener('click', () => {
      input.checked = true
      button.disabled = false
    })

    expect(button.disabled).toBe(true)
    expect(selectResumeInDialog(dialog, '候选人简历C+++.pdf')).toBe(true)
    expect(input.checked).toBe(true)
    expect(button.disabled).toBe(false)
  })

  it('fails closed when the configured resume is not present', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item"><span>另一份材料.pdf</span></label>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const option = dialog.querySelector('label span') as HTMLElement
    setRect(dialog, 720, 398)
    setRect(option, 200, 40)

    expect(selectResumeInDialog(dialog, '指定的软件工程师简历.pdf')).toBe(false)
  })

  it('fails closed when two resume rows normalize to the same best name', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item"><input type="radio"><span>Java C.pdf</span></label>
        <label class="resume-item"><input type="radio"><span>Java C++.pdf</span></label>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const clicks = vi.fn()
    for (const el of Array.from(dialog.querySelectorAll('*'))) {
      setRect(el, 120, 40)
      el.addEventListener('click', clicks)
    }

    expect(selectResumeInDialog(dialog, 'Java C++.pdf')).toBe(false)
    expect(clicks).not.toHaveBeenCalled()
  })

  it('ignores a disabled matching resume row', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item disabled" aria-disabled="true">
          <input type="radio" disabled><span>后端工程师简历.pdf</span>
        </label>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    for (const el of Array.from(dialog.querySelectorAll('*'))) setRect(el, 120, 40)

    expect(selectResumeInDialog(dialog, '后端工程师简历.pdf')).toBe(false)
  })

  it('classifies an unknown resume form separately from safe picker/confirm flows', () => {
    document.body.innerHTML = `
      <div class="dialog-wrap active">
        <div>请补充简历信息</div>
        <input required aria-label="必填字段">
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('.dialog-wrap') as HTMLElement

    expect(resumeDialogKind(dialog)).toBe('unknown')
  })

  it('does not choose between two independent visible resume dialogs', () => {
    document.body.innerHTML = `
      <div role="dialog" id="one"><div>请选择要发送的简历</div><button>发送</button></div>
      <div role="dialog" id="two"><div>确认发送简历</div><button>确认发送</button></div>
    `
    for (const el of Array.from(document.querySelectorAll('[role="dialog"], button'))) {
      setRect(el, 120, 40)
    }

    expect(findResumeDialog()).toBeNull()
  })

  it('fails closed when an unrelated visible dialog competes with the resume dialog', () => {
    document.body.innerHTML = `
      <div role="dialog" id="resume"><div>请选择要发送的简历</div><button>发送</button></div>
      <div role="dialog" id="question"><div>请确认其他事项</div><button>确定</button></div>
    `
    for (const el of Array.from(document.querySelectorAll('[role="dialog"], button'))) {
      setRect(el, 120, 40)
    }

    expect(findResumeDialog()).toBeNull()
  })

  it('fails closed when a picker adds an unknown visible required field', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item selected"><input type="radio" checked><span>后端工程师简历.pdf</span></label>
        <input type="text" required aria-label="新增必填字段">
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    setRect(dialog, 720, 398)
    for (const el of Array.from(dialog.querySelectorAll('*'))) setRect(el, 120, 40)
    const clicks = vi.fn()
    button.addEventListener('click', clicks)

    const result = completeResumeSend('后端工程师简历.pdf')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(false)
    expect(clicks).not.toHaveBeenCalled()
  })

  it('does not treat an unrelated required checkbox as a resume option', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item selected"><input type="radio" checked><span>后端工程师简历.pdf</span></label>
        <label><input type="checkbox" required>同意新增条款</label>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    setRect(dialog, 720, 398)
    for (const el of Array.from(dialog.querySelectorAll('*'))) setRect(el, 120, 40)
    const clicks = vi.fn()
    button.addEventListener('click', clicks)

    const result = completeResumeSend('后端工程师简历.pdf')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(false)
    expect(clicks).not.toHaveBeenCalled()
  })

  it('selects first, waits for enablement, then sends exactly once', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item"><input type="radio"><span>后端工程师简历.pdf</span></label>
        <button type="button" disabled><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const row = dialog.querySelector('label') as HTMLElement
    const input = dialog.querySelector('input') as HTMLInputElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    for (const el of [dialog, row, input, row.querySelector('span')!, button, button.querySelector('span')!]) {
      setRect(el, 120, 40)
    }
    const selections = vi.fn(() => {
      input.checked = true
      button.disabled = false
    })
    const sends = vi.fn(() => dialog.remove())
    row.addEventListener('click', selections)
    button.addEventListener('click', sends)

    const result = completeResumeSend('后端工程师简历.pdf')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(true)
    expect(selections).toHaveBeenCalledTimes(1)
    expect(sends).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unconfirmed send click', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item selected"><span>后端工程师简历.pdf</span></label>
        <button type="button"><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const row = dialog.querySelector('label') as HTMLElement
    const button = dialog.querySelector('button') as HTMLButtonElement
    for (const el of [dialog, row, row.querySelector('span')!, button, button.querySelector('span')!]) {
      setRect(el, 120, 40)
    }
    const sends = vi.fn()
    button.addEventListener('click', sends)

    const result = completeResumeSend('后端工程师简历.pdf')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(false)
    expect(sends).toHaveBeenCalledTimes(1)
  })

  it('ignores hidden dialog remnants after the picker closes', () => {
    document.body.innerHTML = `
      <div class="dialog-wrap upload-resume-dialog">
        <div>请选择要发送的简历</div>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('.dialog-wrap') as HTMLElement
    setRect(dialog, 0, 0)

    expect(findResumeDialog()).toBeNull()
  })

  it('lists picker rows once each, skipping titles, buttons and file metadata', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div class="dialog-header">请选择要发送的简历</div>
        <ul>
          <li class="resume-item selected"><label><input type="radio" checked><span>后端工程师简历.pdf</span><em>2026.10.01</em></label></li>
          <li class="resume-item"><label><input type="radio"><span>算法岗简历.pdf</span><em>320KB</em></label></li>
        </ul>
        <button type="button">上传简历</button>
        <button type="button">发送</button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    for (const el of Array.from(dialog.querySelectorAll('*'))) setRect(el, 120, 30)

    const options = listResumeOptions(dialog)
    expect(options.map((o) => o.name)).toEqual(['后端工程师简历.pdf', '算法岗简历.pdf'])
    expect(options.map((o) => o.selected)).toEqual([true, false])
  })

  it('refuses to send BOSS\'s preselection when several resumes exist and none was chosen', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item selected"><span>后端工程师简历.pdf</span></label>
        <label class="resume-item"><span>算法岗简历.pdf</span></label>
        <button type="button"><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    for (const el of Array.from(dialog.querySelectorAll('*')).concat(dialog)) setRect(el, 120, 30)
    const sends = vi.fn()
    dialog.querySelector('button')!.addEventListener('click', sends)

    const result = completeResumeSend(null)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(false)
    expect(sends).not.toHaveBeenCalled()
  })

  it('still sends without a configured name when the picker holds exactly one resume', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div role="dialog">
        <div>请选择要发送的简历</div>
        <label class="resume-item selected"><span>后端工程师简历.pdf</span></label>
        <button type="button"><span>发送</span></button>
      </div>
    `
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    for (const el of Array.from(dialog.querySelectorAll('*')).concat(dialog)) setRect(el, 120, 30)
    const sends = vi.fn(() => dialog.remove())
    dialog.querySelector('button')!.addEventListener('click', sends)

    const result = completeResumeSend(null)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(true)
    expect(sends).toHaveBeenCalledTimes(1)
  })

  it('recognizes the 2026-10 picker that has no role, no active class and no send button', () => {
    // 结构对应实测截图：标题 + 已上传附件 + 两行（文件名/更新时间/大小）+ 管理附件
    document.body.innerHTML = `
      <div class="boss-popup__wrapper">
        <div class="boss-popup__content">
          <h3 class="title">请选择要发送的简历</h3>
          <p class="sub">已上传附件</p>
          <div class="list">
            <div class="row"><i class="icon"></i><div class="info"><p class="name">蔡韬的简历-agent.pdf</p><p class="meta"><span>更新于2026.10.18 22:03</span><span>263.7KB</span></p></div></div>
            <div class="row"><i class="icon"></i><div class="info"><p class="name">261011.pdf</p><p class="meta"><span>更新于2026.10.11 20:29</span><span>313.2KB</span></p></div></div>
          </div>
          <span class="manage">管理附件</span>
        </div>
      </div>
    `
    for (const el of Array.from(document.querySelectorAll('*'))) setRect(el, 300, 30)

    const dialog = findResumeDialog()
    expect(dialog).not.toBeNull()
    expect(dialog!.classList.contains('boss-popup__content')).toBe(true)
    expect(resumeDialogKind(dialog!)).toBe('picker')
    expect(listResumeOptions(dialog!).map((o) => o.name)).toEqual(['蔡韬的简历-agent.pdf', '261011.pdf'])
  })

  it('selects the whole attachment row, not just the file-name text', () => {
    document.body.innerHTML = `
      <div class="boss-popup__content">
        <h3>请选择要发送的简历</h3>
        <div class="row" id="a"><p class="name">蔡韬的简历-agent.pdf</p><span>263.7KB</span></div>
        <div class="row" id="b"><p class="name">261011.pdf</p><span>313.2KB</span></div>
      </div>
    `
    for (const el of Array.from(document.querySelectorAll('*'))) setRect(el, 300, 30)
    const dialog = document.querySelector('.boss-popup__content') as HTMLElement
    const rowClicks: string[] = []
    for (const row of Array.from(dialog.querySelectorAll('.row'))) {
      row.addEventListener('click', (e) => {
        if (e.target === row) rowClicks.push(row.id)
      })
    }

    expect(selectResumeInDialog(dialog, '261011.pdf')).toBe(true)
    expect(rowClicks).toEqual(['b'])
  })

  it('treats a new "已发送给Boss" mark as success when BOSS sends a single attachment without any dialog', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `<div class="chat-conversation"><div class="item-system"><span>您的附件简历 旧的 已发送给Boss</span></div></div>`
    const panel = document.querySelector('.chat-conversation') as HTMLElement
    setRect(panel, 800, 800)
    const baseline = countResumeSentMarks()
    expect(baseline).toBe(1)

    const result = completeResumeSend(null, false, baseline)
    // BOSS 直接发出：没有任何弹窗，只是消息区多了一条系统提示
    const mark = document.createElement('div')
    mark.className = 'item-system'
    mark.innerHTML = '<span>您的附件简历 261011 已发送给Boss</span>'
    panel.appendChild(mark)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(true)
  })
})

describe('BOSS message reading', () => {
  it('includes HR interaction cards (no span.text-content) in page order', async () => {
    Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {})
    document.body.innerHTML = `
      <div class="chat-conversation">
        <div class="item-myself"><span class="text-content">看到贵司的这个职位，觉得我挺合适</span></div>
        <div class="item-friend"><span class="text-content">你好，方便发一份你的简历过来吗？</span></div>
        <div class="item-friend"><div class="card"><p>我想要一份您的附件简历，您是否同意</p><span>拒绝</span><span>同意</span></div></div>
      </div>
    `
    for (const el of Array.from(document.querySelectorAll('*'))) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30, toJSON: () => ({}),
      })
    }
    vi.spyOn(document.querySelector('.chat-conversation')!, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 800, width: 800, height: 800, toJSON: () => ({}),
    })

    const msgs = await readMessages()
    expect(msgs.map((m) => `${m.sender}:${m.kind}`)).toEqual(['me:text', 'hr:text', 'hr:card'])
    expect(msgs[2].content).toBe('我想要一份您的附件简历，您是否同意')
  })

  it('tells a resume-request card apart from a location-confirm card', async () => {
    Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {})
    document.body.innerHTML = `
      <div class="chat-conversation">
        <div class="item-friend"><div class="card"><p>我想要一份您的附件简历，您是否同意</p><span>拒绝</span><span>同意</span></div></div>
        <div class="item-friend"><div class="card"><p>您是否接受此工作地点：合肥</p><span>暂不考虑</span><span>可以接受</span></div></div>
        <div class="item-friend"><div class="card"><p>方便留个联系方式吗</p><span>拒绝</span><span>同意</span></div></div>
      </div>
    `
    for (const el of Array.from(document.querySelectorAll('*'))) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30, toJSON: () => ({}),
      })
    }
    vi.spyOn(document.querySelector('.chat-conversation')!, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 800, width: 800, height: 800, toJSON: () => ({}),
    })

    const msgs = await readMessages()
    expect(msgs.map((m) => m.cardKind)).toEqual(['resume_request', 'location_confirm', 'contact_exchange'])
    // 卡片正文里不该混进按钮文字
    expect(msgs[0].content).toBe('我想要一份您的附件简历，您是否同意')
    expect(msgs[1].content).toBe('您是否接受此工作地点：合肥')
  })
})

describe('pending card detection', () => {
  function box(top: number, height = 60) {
    return {
      x: 0, y: top, top, left: 0, right: 400, bottom: top + height,
      width: 400, height, toJSON: () => ({}),
    }
  }

  function mockRects(): void {
    for (const el of Array.from(document.querySelectorAll('*')) as HTMLElement[]) {
      // 卡片在上、系统/我方消息在下，模拟真实消息流的位置关系
      const top = el.closest('.item-system, .item-myself') ? 200 : 0
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(box(top))
    }
    vi.spyOn(document.querySelector('.chat-conversation')!, 'getBoundingClientRect').mockReturnValue({
      ...box(0, 800), right: 800, width: 800,
    })
  }

  it('keeps a resume card pending even after we send a plain text reply below it', () => {
    // 实测 bug：我方回一句话后，卡片被误判成已答过，agent 再也点不到
    document.body.innerHTML = `
      <div class="chat-conversation">
        <div class="item-friend"><div class="card"><p>我想要一份您的附件简历，您是否同意</p><button>拒绝</button><button>同意</button></div></div>
        <div class="item-myself"><span class="text-content">您好，可以聊聊</span></div>
      </div>`
    mockRects()

    expect(listPendingCardKinds().map((c) => c.kind)).toEqual(['resume_request'])
  })

  it('treats the card as answered when BOSS disables its buttons', () => {
    // 实测：答过的卡片按钮带 disabled class（地点卡就是这样）
    document.body.innerHTML = `
      <div class="chat-conversation">
        <div class="item-friend"><div class="card"><p>我想要一份您的附件简历，您是否同意</p>
          <span class="card-btn disabled" style="cursor:pointer">拒绝</span><span class="card-btn disabled" style="cursor:pointer">同意</span>
        </div></div>
      </div>`
    mockRects()

    expect(listPendingCardKinds()).toEqual([])
  })
})

describe('choose-resume dialog (measured structure)', () => {
  function setRect(el: Element, w: number, h: number): void {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}),
    })
  }

  function mount(): HTMLElement {
    // 2026-10-20 probe_dom 实测结构
    document.body.innerHTML = `
      <div class="boss-popup__wrapper boss-dialog">
        <div class="boss-popup__content">
          <div class="boss-dialog__header"><h3>请选择要发送的简历</h3></div>
          <div class="boss-dialog__body">
            <div class="choose-resume-dialog">
              <div class="resume-choose-container">
                <div class="resume-title">已上传附件</div>
                <ul class="resume-list">
                  <li class="list-item selected"><span class="icon-file icon-pdf"></span><div class="item-body">蔡韬的简历-agent.pdf 更新于2026.10.18 263.7KB</div><div class="preview">预览</div></li>
                  <li class="list-item"><span class="icon-file icon-pdf"></span><div class="item-body">261011.pdf 更新于2026.10.11 313.2KB</div><div class="preview">预览</div></li>
                </ul>
              </div>
              <div class="footer"><div class="manage-btn"></div><button class="btn-v2 btn-sure-v2 btn-confirm">发送</button></div>
            </div>
          </div>
        </div>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*'))) setRect(el, 520, 40)
    setRect(document.querySelector('.choose-resume-dialog')!, 520, 224)
    return document.querySelector('.choose-resume-dialog') as HTMLElement
  }

  it('recognizes the dialog by choose-resume and lists rows from li.list-item', () => {
    mount()
    const dialog = findResumeDialog()
    expect(dialog?.className).toContain('boss-popup__content')
    expect(resumeDialogKind(dialog!)).toBe('picker')
    const options = listResumeOptions(dialog!)
    expect(options.map((o) => o.name)).toEqual(['蔡韬的简历-agent.pdf', '261011.pdf'])
    expect(options.map((o) => o.selected)).toEqual([true, false])
  })

  it('selects the second row and finds the 发送 button in the same dialog', () => {
    const dialog = mount()
    const clicks: string[] = []
    for (const li of Array.from(dialog.querySelectorAll('li.list-item'))) {
      li.addEventListener('click', () => clicks.push((li.textContent || '').trim().slice(0, 6)))
    }

    expect(selectResumeRowByIndex(dialog, 1)).toBe(true)
    expect(clicks).toHaveLength(1)
    expect(clicks[0]).toContain('261011')
    expect(findDialogButton(dialog, /^(发送|确定)$/)?.textContent).toBe('发送')
  })
})

describe('card handling is retryable', () => {
  function box(top: number, height = 60) {
    return { x: 0, y: top, top, left: 0, right: 400, bottom: top + height, width: 400, height, toJSON: () => ({}) }
  }

  it('unmarks the card when the resume never goes out', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div class="chat-conversation">
        <div class="item-friend"><div class="card">
          <p>我想要一份您的附件简历，您是否同意</p>
          <span class="card-btn" style="cursor:pointer">拒绝</span><span class="card-btn" style="cursor:pointer">同意</span>
        </div></div>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*')) as HTMLElement[]) {
      const inCard = !!el.closest('.item-friend, .item-myself')
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(box(inCard ? 0 : 200))
    }
    vi.spyOn(document.querySelector('.chat-conversation')!, 'getBoundingClientRect')
      .mockReturnValue({ ...box(0, 800), right: 800, width: 800 })

    const result = clickCard('resume_request', true)
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBe(false)
    // 失败必须回滚，否则这张卡会被永久跳过
    expect(listPendingCardKinds().map((c) => c.kind)).toEqual(['resume_request'])
    vi.useRealTimers()
  })
})

describe('resume sent markers', () => {
  it('counts the new system card link 「点击查看附件」 as a sent mark', () => {
    document.body.innerHTML = `
      <div class="chat-conversation">
        <li class="message-item item-system"><div class="message-content"><div class="hyper-link text"><a>点击查看附件</a></div></div></li>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*')) as HTMLElement[]) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 60, width: 400, height: 60, toJSON: () => ({}),
      })
    }
    vi.spyOn(document.querySelector('.chat-conversation')!, 'getBoundingClientRect')
      .mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 800, width: 800, height: 800, toJSON: () => ({}) })

    expect(countResumeSentMarks()).toBe(1)
  })
})

describe('resume dialog false positives', () => {
  it('does not treat the chat list as a resume picker just because it contains .pdf text', () => {
    document.body.innerHTML = `
      <div class="list-warp v2">
        <div class="chat-user v2"><span class="last-msg">您的附件简历 261011.pdf 已发送</span></div>
        <div class="chat-user v2"><span class="last-msg">蔡韬的简历-agent.pdf</span></div>
      </div>`
    for (const el of Array.from(document.querySelectorAll('*'))) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}),
      })
    }
    // 没有「发送」按钮、class 也不像弹窗 → 不能认成选择框
    expect(findResumeDialog()).toBeNull()
  })
})

describe('thread matching', () => {
  it('opens a unique row and confirms its HR, company and job after the header changes', async () => {
    const row = { company: '江苏迈泉科技人事专员', jobTitle: '', name: '周女士' }
    expect(threadRowMatchesText(row, '江苏迈泉科技', '人事专员')).toBe(true)
    expect(threadRowMatchesText(row, '江苏迈泉科技')).toBe(true)
    document.body.innerHTML = `<ul class="user-list">
      <li><span class="name-box"><span class="name-text">吴先生</span>江苏迈泉科技纯客服</span></li>
      <li><span class="name-box"><span class="name-text">周女士</span>江苏迈泉科技人事专员</span></li>
    </ul>`
    const rows = Array.from(document.querySelectorAll('li'))
    const wrong = vi.fn()
    const target = vi.fn()
    Object.assign(rows[0], { __vue__: { handleClick: wrong } })
    Object.assign(rows[1], { __vue__: { handleClick: target } })
    expect(openThread('江苏迈泉科技', '人事专员')).toBe('ok')
    expect(target).toHaveBeenCalledTimes(1)
    expect(wrong).not.toHaveBeenCalled()
    rows[1].querySelector('.name-box')!.textContent = '江苏迈泉科技'
    Object.assign(rows[1], { __vue__: { handleClick: target, boss: { securityId: 'target', name: '周女士', brandName: '江苏迈泉科技', positionName: '人事专员' } } })
    expect(openThread('江苏迈泉科技', '人事专员')).toBe('ok')
    expect(target).toHaveBeenCalledTimes(2)
    expect(wrong).not.toHaveBeenCalled()
    rows[1].insertAdjacentHTML('beforeend', '<span class="position-name">人事专员</span>')
    document.body.insertAdjacentHTML('beforeend', '<section id="header"><span class="name-text">周女士</span><span class="company">江苏迈泉科技</span><span class="position-name">纯客服</span></section>')
    vi.spyOn(document.querySelector('#header .company')!, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 0, top: 0, left: 100, right: 300, bottom: 40, width: 200, height: 40, toJSON: () => ({}),
    })
    expect(currentThreadInfo()).toMatchObject({ company: '江苏迈泉科技', hrName: '周女士', jobTitle: '纯客服' })
    expect(currentThreadId()).toBe('周女士|纯客服')
    vi.useFakeTimers()
    try {
      target.mockImplementationOnce(() => { setTimeout(() => {
        document.querySelector('#header .name-text')!.textContent = '周女士'
        document.querySelector('#header .position-name')!.textContent = '人事专员'
      }, 400) })
      let finished = false
      const result = openThreadConfirmed('江苏迈泉科技', '人事专员').then(value => { finished = true; return value })
      await vi.advanceTimersByTimeAsync(200)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      expect(await result).toBe('ok')
      expect(currentThreadInfo().jobTitle).toBe('人事专员')
      expect(currentThreadId()).toBe('周女士|人事专员')
      expect(target).toHaveBeenCalledTimes(3)
      expect(wrong).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('refuses ambiguity, missing identities, stale headers and cancelled confirmation', async () => {
    const row = { company: '江苏迈泉科技纯客服', jobTitle: '', name: '周女士' }
    expect(threadRowMatchesText(row, '江苏迈泉科技', '人事专员')).toBe(false)
    document.body.innerHTML = `<ul class="user-list">
      <li><span class="name-box"><span class="name-text">吴先生</span>江苏迈泉科技纯客服</span></li>
      <li><span class="name-box"><span class="name-text">周女士</span>江苏迈泉科技纯客服</span></li>
    </ul>`
    const select = vi.fn()
    for (const element of document.querySelectorAll('li')) Object.assign(element, { __vue__: { handleClick: select } })
    expect(openThread('江苏迈泉科技', '人事专员')).toBe('not-found')
    expect(openThread('江苏迈泉科技')).toBe('ambiguous')
    expect(openThread('江苏迈泉科技', '纯客服')).toBe('ambiguous')
    expect(await openThreadConfirmed('江苏迈泉科技', '纯客服')).toBe('ambiguous')
    expect(select).not.toHaveBeenCalled()
    document.querySelectorAll('li')[1].remove()
    document.body.insertAdjacentHTML('beforeend', '<section id="header"><span class="name-text">周女士</span><span class="company">江苏迈泉科技</span><span class="position-name">纯客服</span></section>')
    vi.spyOn(document.querySelector('#header .company')!, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 0, top: 0, left: 100, right: 300, bottom: 40, width: 200, height: 40, toJSON: () => ({}),
    })
    vi.useFakeTimers()
    try {
      const stale = openThreadConfirmed('江苏迈泉科技', '纯客服')
      await vi.runAllTimersAsync()
      expect(await stale).toBe('thread_not_confirmed')
      expect(select).toHaveBeenCalledTimes(1)
      document.querySelector('.name-text')!.textContent = ''
      expect(await openThreadConfirmed('江苏迈泉科技', '纯客服')).toBe('thread_not_confirmed')
      expect(select).toHaveBeenCalledTimes(1)
      document.querySelector('.name-text')!.textContent = '吴先生'
      let cancelled = false
      installToolExecutionGuard(() => { if (cancelled) throw new Error('page_execution_cancelled') })
      const pending = openThreadConfirmed('江苏迈泉科技', '纯客服')
      cancelled = true
      const rejection = expect(pending).rejects.toThrow('page_execution_cancelled')
      await vi.runAllTimersAsync()
      await rejection
      expect(select).toHaveBeenCalledTimes(2)
    } finally { installToolExecutionGuard(null); vi.useRealTimers() }
  })
})

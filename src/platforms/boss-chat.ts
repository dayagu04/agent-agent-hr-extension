// BOSS 聊天页操作（/web/geek/chat）
//
// 职责：读会话列表与消息 → 交后端分类并生成回复 → 在页面内发送 → 回报结果。
// 投递在 /web/geek/jobs，沟通在 /web/geek/chat，两页 DOM 完全不同，故单独成模块。
//
// 红线：只在用户显式启动「会话托管」后运行。发给 HR 的消息不可撤回，
// 全过程由后端 conversation_* 三表留痕（意图/回复/发送结果）供事后评判。
import { diag } from '../logger'
import { assertToolExecutionActive } from '../tool-execution-guard'
import type { AgentPolicy, ContactChannel, PluginConfig } from '../types'
import {
  markChatSent,
  reportChatOutcome,
  syncChatOne,
  reconcileThreads,
} from '../api'
import type { SyncChatResponse } from '../api'
import { chatTargetKey, findPlanTarget, loadChatPlan } from '../chat-plan'
import type { ChatPlanTarget } from '../chat-plan'
import { selectChatActionId, shouldReportContactOnly } from '../chat-action-report'
import {
  actionForCard,
  cardActionAllowed,
  normalizeChatActionPlan,
} from '../chat-action-plan'
import type { ChatActionPlan } from '../chat-action-plan'
import { collectThreadSnapshot } from '../thread-snapshot'
import {
  flushConversationDeletedMarks,
  queueConversationDeletedMark,
  removeMirrorByKey,
} from '../ledger'
import { loadConfig } from '../config'
import {
  contactChannelFromQuestion,
  isAgentActionAllowed,
  isContactExchangeAllowed,
  normalizeContactChannel,
} from '../contact-policy'
import { findByText, findChatPanel, findEditable } from '../domprobe'
import { clickDirect, realClick } from '../dom-events'
import {
  clickDeleteInHeaderMenu,
  confirmDeleteDialog,
  deleteViaRowVue,
  dumpDeleteDiagnostics,
  findBossObject,
  findDeleteItemInPopup,
  isTopmostAtCenter,
  revealOperateBtn,
  unmarkOperateRow,
} from './boss-delete'

/** 聊天页单个会话条目 */
export interface ChatThread {
  el: HTMLElement
  /** HR 姓名（span.name-text） */
  name: string
  company: string
  jobTitle: string
  unread: boolean
  /** BOSS 原生会话/用户标识（data-user-id / data-conversation-id 等） */
  bossId: string
}

const SEL = {
  // 会话列表项（多套候选，BOSS 改版频繁）
  thread: [
    '.geek-item',
    '.user-list li',
    '[class*="chat-user-item"]',
    'li[role="listitem"]',
  ],
  // 消息正文在 span.text-content
  msgText: ['span.text-content', '.text-content'],
  // 会话身份锚点：头部姓名 + 岗位名，用于发送前校验「当前会话是否仍是目标会话」
  headerPosition: ['span.position-name', '.position-name'],
  // 头部薪资/城市：给 HR 主动打招呼的岗位补匹配分 ——
  // 这类岗位用户没投过、库里没 JD，但头部字段足够让匹配引擎跑出分辨力
  headerSalary: ['span.salary', '.salary'],
  headerCity: ['span.city', '.city'],
  input: [
    '#chat-input',
    '.chat-input',
    '[contenteditable="true"]',
    'textarea.input-area',
    'textarea',
  ],
}

function firstMatch(selectors: string[], root: ParentNode = document): HTMLElement | null {
  for (const s of selectors) {
    const el = root.querySelector(s) as HTMLElement | null
    if (el) return el
  }
  return null
}

function allMatch(selectors: string[], root: ParentNode = document): HTMLElement[] {
  for (const s of selectors) {
    const els = Array.from(root.querySelectorAll(s)) as HTMLElement[]
    if (els.length) return els
  }
  return []
}

const text = (el: Element | null | undefined) => (el?.textContent || '').trim()
const delay = async (min: number, max: number) => {
  assertToolExecutionActive()
  await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)))
  assertToolExecutionActive()
}

/** 从会话行 DOM 提取 BOSS 原生唯一标识（threadKey 与删除定位共用同一来源）。 */
function readBossId(el: HTMLElement): string {
  return (
    el.getAttribute('data-user-id') ||
    el.getAttribute('data-conversation-id') ||
    el.getAttribute('data-geek-id') ||
    el.getAttribute('data-boss-id') ||
    el.querySelector('[data-user-id]')?.getAttribute('data-user-id') ||
    el.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id') ||
    el.querySelector('[data-geek-id]')?.getAttribute('data-geek-id') ||
    ''
  )
}

/** 只记录不可逆还原的会话统计；消息、姓名、公司和岗位原文不得进入普通日志。 */
function logChatHistory(
  _t: ChatThread,
  messages: Array<{ sender: 'hr' | 'me' | 'system'; content: string }>,
): void {
  const counts = { hr: 0, me: 0, system: 0 }
  let totalChars = 0
  for (const message of messages) {
    counts[message.sender]++
    totalChars += (message.content || '').length
  }
  diag('HIST', '会话历史摘要', {
    messageCount: messages.length,
    senderCounts: counts,
    totalChars,
    lastSender: messages.at(-1)?.sender || 'none',
  })
}

/** 是否在 BOSS 聊天页 */
export function onChatPage(): boolean {
  return /\/web\/geek\/chat/.test(location.pathname)
}

/**
 * 通过 Vue 实例直接切换会话（首选方案）。
 *
 * 合成鼠标/pointer 事件点击会话列表不可靠（头部 nowId 始终不变），
 * 而会话项挂着 __vue__，可直接读组件数据、调组件方法，绕开事件模拟。
 *
 * @returns 是否成功触发切换
 */
function switchThreadViaVue(el: HTMLElement): boolean {
  assertToolExecutionActive()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vm = (el as any).__vue__
  if (!vm) return false

  // 元素必须仍挂在文档上：虚拟列表滚动时会重建节点，脱离 DOM 的引用
  // 即使 __vue__ 仍在、方法调得通，页面也不会响应。
  if (!el.isConnected) {
    diag('CHAT', 'Vue 切换放弃：节点已脱离 DOM（列表被重建）')
    return false
  }

  try {
    // 会话数据通常在 vm.data / vm.item / vm.friend / vm.$props 上
    const cand = vm.data || vm.item || vm.friend || vm.conversation || vm.$props?.data
    if (cand) {
      const keys = Object.keys(cand).filter((k) => /id|uid|encrypt|security/i.test(k))
      diag('CHAT', `Vue 数据可用字段: ${keys.slice(0, 8).join(',')}`)
    }

    // 优先调组件自身的选中方法（名字按常见约定逐个试）
    for (const fn of ['handleClick', 'onClick', 'selectItem', 'handleSelect', 'chooseItem']) {
      if (typeof vm[fn] === 'function') {
        vm[fn](cand)
        diag('CHAT', `已调用 Vue 方法 ${fn}()`)
        return true
      }
    }

    // 退一步：向父组件（列表）派发选中事件
    let p = vm.$parent
    for (let i = 0; i < 5 && p; i++) {
      for (const fn of ['selectFriend', 'handleItemClick', 'onSelectItem', 'switchChat']) {
        if (typeof p[fn] === 'function') {
          p[fn](cand)
          diag('CHAT', `已调用父组件方法 ${fn}()`)
          return true
        }
      }
      p = p.$parent
    }

    // 再退一步：走 Vue 事件总线
    if (typeof vm.$emit === 'function' && cand) {
      vm.$emit('click', cand)
      vm.$emit('select', cand)
      diag('CHAT', '已 $emit click/select')
      return true
    }
  } catch (e) {
    diag('CHAT', 'Vue 切换异常', { errorType: (e as Error).name || 'Error' })
  }
  return false
}

/**
 * 解析会话列表，不打日志。
 *
 * 重新定位节点时会被频繁调用（每个会话一次），走 listThreads() 会把
 * 「会话列表 N 个」刷满日志区，把真正有用的行挤出 MAX_LINES 窗口。
 */
function listThreadsQuiet(): ChatThread[] {
  const items = allMatch(SEL.thread)
  const threads: ChatThread[] = []
  for (const el of items) {
    // 结构：div.title-box > span.name-box > span.name-text + i.vline + <公司/职位元素>。
    // 列表项没有独立岗位名元素；公司取 name-box 全文去掉姓名后的剩余。
    const name = text(el.querySelector('.name-text'))
    let company = text(el.querySelector('.name-box'))
    if (name && company.startsWith(name)) {
      company = company.slice(name.length).trim()
    }
    const jobTitle = text(el.querySelector('[class*="job"], .source-job'))
    // 未读标记：红点/数字气泡
    const unread = !!el.querySelector('.badge-count, [class*="badge"], [class*="unread"]')
    threads.push({ el, name, company: company || name, jobTitle, unread, bossId: readBossId(el) })
  }
  return threads
}

export function listThreads(): ChatThread[] {
  const threads = listThreadsQuiet()
  const src = threadUnreadFromSources()
  // DOM 只数到「当前渲染出来的行」（虚拟列表滚走的行不在 DOM 里），
  // 所以和导航角标对不上；dataSources 是完整会话列表，以它为准。
  diag(
    'CHAT',
    `会话列表 ${threads.length} 个（未读 ${threads.filter((t) => t.unread).length}）` +
      (src
        ? ` sources=${src.threads} unreadThreads=${src.unreadThreads} unreadMessages=${src.unreadMessages}`
        : ' sources=none'),
  )
  if (!threads.length) {
    const guess = Array.from(document.querySelectorAll('li, div'))
      .map((e) => String((e as HTMLElement).className || ''))
      .filter((c) => /geek|user|chat|item/i.test(c))
      .slice(0, 20)
    diag('CHAT', '未识别会话列表，class 采样', guess)
  }
  // 岗位名提取缺失诊断：BOSS 列表条目通常含岗位名，提取不到说明选择器需要修正。
  // 每次页面加载只 dump 一次前 3 条的结构到日志，用户回传日志即可开发（不靠猜测）。
  if (!dumpedMissingJobTitle) {
    const missingJob = threads.filter((t) => !t.jobTitle).slice(0, 3)
    if (missingJob.length) {
      dumpedMissingJobTitle = true
      diag(
        'CHAT',
        `会话条目缺少岗位名（${missingJob.length}/${threads.length} 条），dump 结构`,
        missingJob.map((t) => ({
          el: `${t.el.tagName.toLowerCase()}.${String(t.el.className || '').split(/\s+/).slice(0, 3).join('.')}`,
          textLength: (t.el.textContent || '').trim().length,
          children: Array.from(t.el.querySelectorAll('[class]')).slice(0, 15).map(
            (e) =>
              `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(/\s+/).slice(0, 2).join('.')}`,
          ),
        })),
      )
    }
  }
  return threads
}

/** boss 对象上可能的岗位名字段（与头部 span.position-name 同名优先） */
const JOB_TITLE_KEYS = ['positionName', 'position_name', 'jobTitle', 'jobName', 'postName']
/** boss 对象上可能的薪资字段 */
const SALARY_KEYS = ['salary', 'salaryDesc', 'salaryText', 'salaryInfo', 'price', 'jobSalary']
/** 泛化键（position/job）可能是「人事/招聘经理」这类角色而非岗位名，需过滤 */
const ROLE_ONLY = /^(hr|人事|招聘经理|招聘主管|招聘专员|猎头顾问|总监|经理|主管|顾问)$/i

/**
 * 无感读取列表行的岗位名/薪资。
 *
 * 列表项 DOM 里没有岗位名（岗位名只在会话头部），但行组件 Vue 实例的
 * boss 对象通常带 positionName / salary，直接读对象即可，无需切换会话。
 * 找不到时 dump 一次 boss 对象键供适配（不往 BOSS 对象上写任何字段）。
 */
export function readRowJobInfo(li: HTMLElement): {
  title: string
  salary: string
  jobId: string
  brandName: string
  hrName: string
} {
  const hosts = [
    li.querySelector('.gray.last-msg'),
    li.querySelector('.last-msg'),
    li.querySelector('.friend-content'),
    li,
  ].filter(Boolean) as HTMLElement[]
  for (const host of hosts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vm = (host as any).__vue__
    if (!vm) continue
    const boss = findBossObject(vm)
    if (!boss?.obj) continue
    let title = ''
    let salary = ''
    const jobId = String(boss.obj.encryptJobId || boss.obj.jobId || '')
    const brandName = String(boss.obj.brandName || '')
    const hrName = String(boss.obj.name || '')
    for (const k of JOB_TITLE_KEYS) {
      const v = boss.obj[k]
      if (typeof v === 'string' && v.trim()) {
        title = v.trim()
        break
      }
    }
    for (const k of ['position', 'job']) {
      const v = boss.obj[k]
      if (!title && typeof v === 'string' && v.trim() && !ROLE_ONLY.test(v.trim())) {
        title = v.trim()
        break
      }
    }
    for (const k of SALARY_KEYS) {
      const v = boss.obj[k]
      if (typeof v === 'string' && /\d/.test(v)) {
        salary = v.trim()
        break
      }
    }
    if (title || salary || jobId) {
      return { title, salary, jobId, brandName, hrName }
    }
    // 页面加载内只 dump 一次，避免刷屏
    if (!dumpedBossKeys) {
      dumpedBossKeys = true
      diag('CHAT', 'boss 对象无岗位名/薪资/jobId，dump 键（供适配）', {
        path: boss.path,
        keys: Object.keys(boss.obj).filter((k) => !k.startsWith('_')).slice(0, 25),
        stringFields: Object.entries(boss.obj)
          .filter(([, v]) => typeof v === 'string')
          .slice(0, 15)
          .map(([key, value]) => ({ key, length: (value as string).length })),
      })
    }
    return { title: '', salary: '', jobId: '', brandName, hrName }
  }
  return { title: '', salary: '', jobId: '', brandName: '', hrName: '' }
}

/**
 * 读取某一行的 boss 对象结构（键名 + 短字符串值），供工具 probe_row 使用。
 * 只用于开发期适配，不参与业务逻辑。
 */
export function probeRowObject(li: HTMLElement): {
  path: string
  keys: string[]
  strings: Array<{ key: string; len: number; value: string }>
} | null {
  const hosts = [
    li.querySelector('.gray.last-msg'),
    li.querySelector('.last-msg'),
    li.querySelector('.friend-content'),
    li,
  ].filter(Boolean) as HTMLElement[]
  for (const host of hosts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vm = (host as any).__vue__
    if (!vm) continue
    const boss = findBossObject(vm)
    if (!boss?.obj) continue
    const obj = boss.obj as Record<string, unknown>
    const strings: Array<{ key: string; len: number; value: string }> = []
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string' || !v.trim() || v.length > 60) continue
      strings.push({ key: k, len: v.length, value: v.trim() })
    }
    return {
      path: boss.path,
      keys: Object.keys(obj).filter((k) => !k.startsWith('_')).slice(0, 40),
      strings,
    }
  }
  return null
}

/** 页面加载内只 dump 一次 boss 对象键 */
let dumpedBossKeys = false

/** 页面加载内只 dump 一次岗位名缺失诊断，避免 60s 刷新刷屏日志 */
let dumpedMissingJobTitle = false
/**
 * 删除指定会话。
 *
 * 完整流程：
 *   1. 找到目标会话项：优先按身份精确匹配（encryptJobId / bossId），
 *      身份缺失时才退回公司名子串滚动查找（虚拟列表只渲染约 40 项）
 *   2. 鼠标移到该项 → 右下角出现「···」按钮（Vue 条件渲染，非 CSS 隐藏）
 *   3. 点「···」→ 弹出浮层菜单（只有「置顶」「删除」两项）
 *   4. 点「删除」→ 弹「确认删除吗？」→ 点「确定」
 *   5. 校验该会话确实从列表消失
 *
 * 不走右侧会话头部菜单：那条路要先切换会话（多一次切换 + 身份核对，
 * 且会改变用户当前正在看的会话）。
 *
 * @returns 'ok' 已删除 | 'not-found' 列表里没有匹配项 | 'failed' 找到但删除失败
 */
async function deleteThreadImpl(
  company: string,
  jobTitle = '',
  identity?: { bossId?: string; encryptJobId?: string },
  onTarget?: (target: DeletedThreadTarget) => void,
): Promise<'ok' | 'not-found' | 'failed'> {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const target = norm(company)
  if (!target) return 'not-found'
  void norm(jobTitle)

  // 步骤 1：找到会话项（含滚动查找）
  const hit = await findThreadForDelete(company, jobTitle, identity)
  if (!hit) {
    diag('CHAT', 'deleteThread 未找到会话（含滚动查找）')
    return 'not-found'
  }
  if (onTarget) {
    // Capture the actual row before BOSS removes it; the background can then reconcile the exact job.
    const info = readRowJobInfo(hit.el)
    onTarget({
      company: info.brandName || company || hit.company,
      jobTitle: info.title || hit.jobTitle || jobTitle,
      bossId: identity?.bossId || hit.bossId || '',
      encryptJobId: identity?.encryptJobId || info.jobId || '',
    })
  }

  // 删除结果校验按「身份是否还在列表里」判断：虚拟列表节点数恒定，
  // 删一条后下一条补位、长度不变，不能比长度或 isConnected。
  const wantKey = threadKey(hit)
  const isGone = () => !listThreadsQuiet().some((t) => threadKey(t) === wantKey)

  /**
   * 点确认弹窗 + 校验会话是否真的从列表消失。
   *
   * 弹窗探测与「目标已从列表消失」并行：deleteViaRowVue 直接调组件方法时
   * BOSS 往往不弹确认窗，原来固定等 14 轮（约 5 秒）纯属浪费；现在
   * confirmDeleteDialog 每轮先查 gone，会话已消失立即返回。
   */
  const confirmAndVerify = async (label: string): Promise<boolean> => {
    await delay(300, 450)
    const confirmed = await confirmDeleteDialog({ gone: isGone })
    if (!confirmed) diag('CHAT', `${label}：未点到确认按钮，继续校验实际结果`)
    for (let i = 0; i < 6; i++) {
      if (isGone()) {
        diag('CHAT', `${label} 已删除`)
        return true
      }
      await delay(300, 450)
    }
    return false
  }

  try {
    hit.el.scrollIntoView({ block: 'center' })
    await delay(300, 450)

    // 首选：直接调用该行组件自己的 deleteBoss()。
    // 它就是「删除」菜单项最终调用的方法，跳过全部 DOM 交互，
    // 且作用对象就是这一行，不存在删错会话的可能。
    assertToolExecutionActive()
    if (deleteViaRowVue(hit.el)) {
      if (await confirmAndVerify('deleteViaRowVue')) return 'ok'
      diag('CHAT', 'deleteViaRowVue 调用成功但会话仍在列表，继续尝试点击路径')
    }

    // 步骤 2：唤出「···」按钮（注入 CSS 绕过 :hover 闸门，见 boss-delete.ts）
    const opBtn = await revealOperateBtn(hit.el)
    if (!opBtn) {
      diag('CHAT', 'deleteThread 未能唤出「···」操作按钮', {
        hasCompany: !!hit.company,
        itemNodes: Array.from(hit.el.querySelectorAll('*'))
          .map((e) => {
            const el = e as HTMLElement
            const r = el.getBoundingClientRect()
            return `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 24)}` +
              `[${Math.round(r.width)}x${Math.round(r.height)}]`
          })
          .slice(0, 20),
      })
      dumpDeleteDiagnostics(hit.el, '按钮未找到')
      unmarkOperateRow(hit.el)
      return 'failed'
    }
    const btnRect = opBtn.getBoundingClientRect()
    diag('CHAT', 'deleteThread 已唤出操作按钮', {
      el: `${opBtn.tagName.toLowerCase()}.${String(opBtn.className || '').slice(0, 30)}`,
      size: `${Math.round(btnRect.width)}x${Math.round(btnRect.height)}`,
    })

    // 步骤 3：点「···」展开菜单。判据是「中心点处最上层的节点是不是它自己」，
    // 被其它节点盖住时必须直接派发到目标元素本身。
    if (isTopmostAtCenter(opBtn)) realClick(opBtn)
    else {
      diag('CHAT', '操作按钮被其它节点遮挡，改为直接派发点击')
      clickDirect(opBtn)
    }
    await delay(350, 550)

    let del = findDeleteItemInPopup()
    if (!del) {
      // 菜单可能需要多等一会（浮层有动画），轮询几轮
      for (let i = 0; i < 5 && !del; i++) {
        await delay(250, 400)
        del = findDeleteItemInPopup()
      }
    }
    if (!del) {
      diag('CHAT', 'deleteThread 列表浮层未出现「删除」项，改走头部菜单', {
        hasCompany: !!hit.company,
      })
      dumpDeleteDiagnostics(hit.el, '列表浮层未出现')
      unmarkOperateRow(hit.el)
      // 降级到头部菜单（常驻 DOM、点击展开）；它作用于当前打开的会话，
      // 必须先切到目标会话并核对身份 —— 由 deleteViaHeaderMenu 内部把关。
      if (await deleteViaHeaderMenu(hit)) return 'ok'
      return 'failed'
    }

    // 步骤 4：点「删除」→ 确认弹窗
    unmarkOperateRow(hit.el) // 菜单已出，撤掉强制样式，避免留下视觉异常
    realClick(del)
    await delay(300, 450)
    const confirmed = await confirmDeleteDialog({ gone: isGone })
    if (!confirmed) {
      // 可能 BOSS 已改为无需确认，交给后续校验判定
      diag('CHAT', 'deleteThread 未点到确认按钮，继续校验实际结果')
    }

    // 步骤 5：校验
    for (let i = 0; i < 6; i++) {
      if (isGone()) {
        diag('CHAT', 'deleteThread 已删除')
        return 'ok'
      }
      await delay(300, 450)
    }
    diag('CHAT', 'deleteThread 流程走完但会话仍在列表中，改走头部菜单')
    // 列表路径走完仍在 → 再试头部菜单（同上，身份由内部核对）
    if (await deleteViaHeaderMenu(hit)) return 'ok'
    return 'failed'
  } catch (e) {
    diag('CHAT', 'deleteThread 异常', { errorType: (e as Error).name || 'Error' })
    unmarkOperateRow(hit.el)
    return 'failed'
  }
}

/**
 * 定位要删除的会话行。
 *
 * 身份优先（encryptJobId / bossId 精确），身份缺失或没命中时退回公司名子串：
 * - encryptJobId：从 virtual-list.dataSources 全量列表精确找（一次拿到全部会话），
 *   命中后只滚动到该行（不切换会话），同公司多岗位也不会删错；
 * - bossId：在已渲染行里按 data-user-id 精确找；
 * - 兜底：公司名子串滚动查找（旧行为）。
 */
/**
 * 会话行是否匹配「公司 + 岗位名」。
 *
 * BOSS 列表行常常没有独立岗位字段，岗位名被拼进公司文本
 * （实测 company="江苏迈泉科技人事专员"、jobTitle=""），所以岗位名要在
 * 整行文本里找，不能只看 jobTitle。
 */
export function threadRowMatchesText(
  t: { company?: string; jobTitle?: string; name?: string },
  company: string,
  jobTitle = '',
): boolean {
  const norm = (v?: string) => (v || '').replace(/\s+/g, '').toLowerCase()
  const target = norm(company)
  if (!target) return false
  if (!norm(t.company).includes(target)) return false
  const wantJob = norm(jobTitle)
  if (!wantJob) return true
  return norm(`${t.company || ''}${t.jobTitle || ''}${t.name || ''}`).includes(wantJob)
}

async function findThreadForDelete(
  company: string,
  jobTitle: string,
  identity?: { bossId?: string; encryptJobId?: string },
): Promise<ChatThread | null> {
  const jobId = (identity?.encryptJobId || '').trim()
  const bossId = identity?.bossId || ''

  // 1) 全量数据源按岗位 ID 精确定位（最稳）；inbound 虚拟 id 与 BOSS 真实
  //    jobId 对不上，跳过精确匹配，走公司兜底。
  if (jobId && !jobId.startsWith('inbound:')) {
    const sources = readChatSources()
    if (sources) {
      const src = sources.find((s) => String(s.boss.encryptJobId || '') === jobId)
      if (src) {
        const t = await locateRowByIndex(src.index)
        if (t) return t
      }
    }
  }

  // 2) 已渲染行按 bossId 精确定位
  if (bossId) {
    const hit = listThreadsQuiet().find((t) => t.bossId === bossId)
    if (hit) return hit
  }

  // 3) 兜底：滚动查找（身份精确命中优先，否则退回公司名子串）
  const match = (t: ChatThread): boolean => {
    if (bossId && t.bossId && t.bossId === bossId) return true
    if (jobId) {
      const row = readRowJobInfo(t.el)
      if (row.jobId && row.jobId === jobId) return true
    }
    return threadRowMatchesText(t, company, jobTitle)
  }
  return findThreadByScrolling(match)
}

/** 渲染并返回指定下标的会话行（只滚动，不切换会话 —— 删除路径无需打开对话）。 */
async function locateRowByIndex(index: number): Promise<ChatThread | null> {
  const vl = findVirtualListVm()
  if (!vl) return null
  await scrollToSourceIndex(vl, index)
  const threads = listThreadsQuiet()
  let hit = threads.find(
    (t) => (t.el as AnyVm).__vue__?.$props?.index === index,
  )
  if (!hit) {
    hit = threads.find(
      (t) => (t.el as AnyVm).__vue__?.$parent?.$props?.index === index,
    )
  }
  return hit || null
}

/**
 * 删除会话（手动路径）：成功后同步标记后端记录 + 清本地镜像。
 *
 * @param identity bossId（DOM 原生标识）/ encryptJobId（后端 Job.platform_job_id），
 *                 用于精确删除定位与后端对账，避免同公司多会话误删/误标。
 */
export interface DeletedThreadTarget {
  company: string
  jobTitle: string
  bossId?: string
  encryptJobId?: string
}

export async function deleteThread(
  company: string,
  jobTitle = '',
  identity?: { bossId?: string; encryptJobId?: string },
  afterDeleted?: (target: DeletedThreadTarget) => Promise<void>,
): Promise<'ok' | 'not-found' | 'failed'> {
  let target: DeletedThreadTarget = { company, jobTitle, ...identity }
  const r = await deleteThreadImpl(company, jobTitle, identity, afterDeleted ? (actual) => { target = actual } : undefined)
  if (r === 'ok') {
    if (afterDeleted) await afterDeleted(target)
    else await afterConversationDeleted(company, jobTitle, 'manual', identity)
  }
  return r
}

/**
 * 降级路径：切到目标会话，用会话头部那个常驻菜单删除。
 *
 * 头部菜单（置顶/备注/不感兴趣/黑名单/删除/举报）常驻 DOM 且靠点击展开，
 * 不依赖列表项按钮的 CSS :hover。它作用于「当前打开的会话」，
 * 切错人就删错会话且不可撤回，故必须核对身份：目标本来已打开（身份对上）
 * 或切换后头部姓名出现在列表项 company 串里，任一不过就放弃。
 */
async function deleteViaHeaderMenu(hit: ChatThread): Promise<boolean> {
  const wantKey = threadKey(hit)
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()

  // 列表项是「姓名+公司+职务」拼接串，头部只有姓名，
  // 用「头部姓名 ⊂ 列表串」判定是同一个人。
  const identityMatches = (): boolean => {
    const h = findChatHeader()
    const hName = norm(text(h ? headerNameIn(h) : null))
    return !!hName && norm(hit.company).includes(hName)
  }

  // 目标本来就是当前会话时无需切换（身份对得上即可，不能只看 id 变没变）
  if (!identityMatches()) {
    const beforeId = currentThreadId()
    try {
      if (!switchThreadViaVue(hit.el)) realClick(hit.el)
    } catch (e) {
      diag('CHAT', '头部菜单删除：切换会话异常', {
        errorType: (e as Error).name || 'Error',
      })
      return false
    }

    // 等切换生效：以「身份对上」为准
    let ok = false
    for (const d of [300, 400, 500, 700, 900, 1100, 1400]) {
      await delay(d, d + 150)
      if (identityMatches()) {
        ok = true
        break
      }
    }
    if (!ok) {
      diag('CHAT', '头部菜单删除已放弃：切换后头部身份仍与目标不一致', {
        hadBeforeId: !!beforeId,
        hasCurrentId: !!currentThreadId(),
      })
      return false
    }
  } else {
    diag('CHAT', '头部菜单删除：目标会话已是当前会话，无需切换')
  }

  const header = findChatHeader()
  if (!header) {
    diag('CHAT', '头部菜单删除已放弃：未找到会话头部')
    return false
  }
  const verify = (): boolean => {
    const ok = identityMatches()
    if (!ok) {
      diag('CHAT', '头部菜单删除已放弃：身份核对不通过', {
        headerNamePresent: !!norm(text(headerNameIn(header))),
        listCompanyPresent: !!hit.company,
      })
    }
    return ok
  }

  const clicked = await clickDeleteInHeaderMenu(header, verify, insideThreadList)
  if (!clicked) return false

  await delay(300, 450)
  const confirmed = await confirmDeleteDialog()
  if (!confirmed) diag('CHAT', '头部菜单删除：未点到确认按钮，继续校验实际结果')

  for (let i = 0; i < 10; i++) {
    if (!listThreadsQuiet().some((t) => threadKey(t) === wantKey)) {
      diag('CHAT', '头部菜单删除成功')
      return true
    }
    await delay(300, 450)
  }
  diag('CHAT', '头部菜单删除流程走完但会话仍在列表中')
  return false
}

/**
 * 在会话列表中滚动查找匹配的会话项。
 *
 * 虚拟列表只渲染当前窗口约 40 项，窗口外的会话需滚动加载。
 * 查找完成后把滚动位置复位，避免影响用户视野。
 */
async function findThreadByScrolling(
  match: (t: ChatThread) => boolean,
): Promise<ChatThread | null> {
  // 先查当前窗口（绝大多数情况命中，不必滚动）
  const inWindow = listThreadsQuiet().find(match)
  if (inWindow) return inWindow

  const container = findThreadScrollContainer()
  if (!container) return null

  const restore = container.scrollTop
  const step = Math.max(1, Math.floor(container.clientHeight * 0.8))
  const maxScroll = container.scrollHeight - container.clientHeight

  try {
    for (let top = 0; top <= maxScroll + step; top += step) {
      container.scrollTo({ top: Math.min(top, maxScroll) })
      await delay(400, 550) // 等虚拟列表渲染
      const found = listThreadsQuiet().find(match)
      if (found) return found
    }
    return null
  } finally {
    // 命中时不复位：调用方接着要点这个节点，复位会把它滚出窗口、
    // 让虚拟列表回收掉刚拿到的引用。未命中才复位。
    if (!listThreadsQuiet().find(match)) container.scrollTo({ top: restore })
  }
}

/**
 * 在会话列表里定位并打开指定会话（供面板点 HR 卡片跳转用）。
 *
 * 岗位名可能拼在整行文本中，也可能只存在行组件数据中。
 * 显式岗位不能退回公司首条；匹配多条时拒绝切换，由调用方进一步限定目标。
 *
 * @returns 'ok' 已触发切换 | 'not-found' 无匹配 | 'ambiguous' 多条匹配 | 'failed' 切换失败
 */
function findThreadToOpen(company: string, jobTitle: string): ChatThread | 'not-found' | 'ambiguous' {
  const threads = listThreads()
  const matches = threads.filter((thread) => {
    if (threadRowMatchesText(thread, company, jobTitle)) return true
    const info = readRowJobInfo(thread.el)
    return threadRowMatchesText({ ...thread, company: info.brandName || thread.company, jobTitle: info.title || thread.jobTitle }, company, jobTitle)
  })
  if (!matches.length) {
    diag('CHAT', 'openThread 未找到会话', { candidateCount: Math.min(threads.length, 8) })
    return 'not-found'
  }
  if (matches.length > 1) {
    diag('CHAT', 'openThread 目标不唯一', { matches: matches.length })
    return 'ambiguous'
  }
  return matches[0]
}

function activateThread(hit: ChatThread): 'ok' | 'failed' {
  try {
    if (!switchThreadViaVue(hit.el)) realClick(hit.el)
    diag('CHAT', 'openThread 已切换')
    return 'ok'
  } catch (e) {
    diag('CHAT', 'openThread 切换异常', { errorType: (e as Error).name || 'Error' })
    return 'failed'
  }
}

export function openThread(company: string, jobTitle = ''): 'ok' | 'not-found' | 'ambiguous' | 'failed' {
  const target = findThreadToOpen(company, jobTitle)
  return typeof target === 'string' ? target : activateThread(target)
}

/** Tool calls must observe the intended header before a subsequent send is allowed. */
export async function openThreadConfirmed(company: string, jobTitle = ''): Promise<'ok' | 'not-found' | 'ambiguous' | 'failed' | 'thread_not_confirmed'> {
  assertToolExecutionActive()
  // Resolve uniqueness even when a matching header is already open: company alone cannot identify an HR.
  const target = findThreadToOpen(company, jobTitle)
  if (typeof target === 'string') return target
  const row = readRowJobInfo(target.el)
  const norm = (value: string) => value.replace(/\s+/g, '').toLowerCase()
  const expected = {
    company: norm(row.brandName || company),
    hrName: norm(row.hrName || target.name),
    jobTitle: norm(row.title || target.jobTitle || jobTitle),
  }
  // Missing identity is not evidence that the current conversation is the requested one.
  if (!expected.company || !expected.hrName || !expected.jobTitle) return 'thread_not_confirmed'
  const confirmed = () => {
    const header = currentThreadInfo()
    return norm(header.company) === expected.company && norm(header.hrName) === expected.hrName && norm(header.jobTitle) === expected.jobTitle
  }
  if (confirmed()) return 'ok'
  const activated = activateThread(target)
  assertToolExecutionActive()
  if (activated !== 'ok') return activated
  for (let attempt = 0; attempt <= 15; attempt++) {
    assertToolExecutionActive()
    if (confirmed()) return 'ok'
    if (attempt < 15) await delay(200, 200)
  }
  return 'thread_not_confirmed'
}

/** 读当前打开会话的消息（区分 hr / me）。会先滚动到底部确保全部加载。 */
/** BOSS 系统通知文本模式（不是 HR 说话，不能当 HR 消息回复/统计） */
const SYSTEM_MSG_RE = /^(对方已(查看|同意|接受|拒绝)|附件简历已(发送|送达)|撤回了一条消息|已交换联系方式|职位(已下线|已关闭)|系统消息)/

/**
 * 会话已在 BOSS 端删除：同步标记后端记录（status=deleted，跨轮次不再残留）
 * 并清本地镜像。三个删除路径（超时清理/被拒删除/手动删除）共用。
 *
 * 标记走「入队 + 补发」：网络失败留在队列，下次刷新/托管轮次自动补发，
 * 不再 fire-and-forget 静默丢失（丢失的后果是后端死会话残留、每轮重试）。
 * identity.encryptJobId 是后端 Job.platform_job_id，供精确标记。
 */
async function afterConversationDeleted(
  company: string,
  jobTitle: string,
  reason: string,
  identity?: { encryptJobId?: string },
): Promise<void> {
  const cfg = loadConfig()
  await queueConversationDeletedMark({
    company,
    job_title: jobTitle,
    reason,
    encrypt_job_id: identity?.encryptJobId || '',
  })
  await flushConversationDeletedMarks(cfg)
  await removeMirrorByKey(company, jobTitle, identity)
  // 通知面板：自动删除后镜像已变，立即重渲染，不再等 60s 轮询
  try {
    window.dispatchEvent(new CustomEvent('aah:chat-mirror-changed'))
  } catch {
    /* 事件派发失败不影响删除结果 */
  }
}

export interface ChatMessage {
  sender: 'hr' | 'me' | 'system'
  content: string
  /** card = 交互卡片（索要简历/交换联系方式/确认地点等，带同意/拒绝按钮），没有 text-content 正文 */
  kind?: 'text' | 'card'
  /** 卡片类型：与自动处理用的 classifyCard 同一套判据，便于区分「索要简历 / 确认工作地点 / 交换联系方式」 */
  cardKind?: 'resume_request' | 'location_confirm' | 'contact_exchange' | 'unknown'
}

/** 卡片里的按钮/附属文字，不算卡片正文 */
const CARD_CHROME_RE = /^(同意|拒绝|可以接受|暂不考虑|已同意|已拒绝|查看|去查看|立即查看|送达|已读|未读)$/

/** 交互卡片正文：去掉按钮、头像、时间、已读标记，剩下的叶子文本拼起来 */
function cardText(bubble: HTMLElement): string {
  const parts: string[] = []
  for (const el of Array.from(bubble.querySelectorAll('*')) as HTMLElement[]) {
    if (el.children.length) continue
    if (el.closest('.message-status, .image-circle, [class*="avatar"], [class*="time"]')) continue
    const t = (el.textContent || '').trim()
    if (!t || CARD_CHROME_RE.test(t)) continue
    parts.push(t)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export async function readMessages(
  opts: { verbose?: boolean } = {},
): Promise<ChatMessage[]> {
  // 滚到消息区底部，确保读到最后一条。findChatPanel() 返回的容器不一定是
  // 可滚动节点，需从消息节点往上找真正可滚动的祖先。
  const panel = findChatPanel()
  if (panel) {
    const anchor = firstMatch(SEL.msgText, panel) || panel
    let sc: HTMLElement | null = anchor
    for (let i = 0; i < 8 && sc; i++) {
      if (sc.scrollHeight > sc.clientHeight + 4) break
      sc = sc.parentElement
    }
    if (sc) {
      sc.scrollTo({ top: sc.scrollHeight })
      await delay(120, 220)
    }
  }

  const out: ChatMessage[] = []
  /** 每条消息对应的 DOM 节点，最后按文档顺序排序（卡片和文本是分两轮收集的） */
  const anchors: HTMLElement[] = []
  const dbg: string[] = []
  if (!panel) return out
  const pr = panel.getBoundingClientRect()
  const mid = pr.left + pr.width / 2

  for (const el of allMatch(SEL.msgText, panel)) {
    const content = text(el)
    if (!content || content.length > 800) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue

    // 收发方判断：精确匹配 class token，避免模糊匹配导致误判
    const bubble = el.closest('.item-friend, .item-myself, .item-system') || el.parentElement
    const scope = (bubble || el) as HTMLElement
    const clsList = Array.from((scope as Element).classList || [])
    let isMe: boolean | null = null
    const hasStatus = !!scope.querySelector('.message-status')
    const hasAvatar = !!scope.querySelector('.image-circle')

    // 精确匹配 item-myself/item-friend/item-system
    if (clsList.includes('item-myself')) isMe = true
    else if (clsList.includes('item-friend')) isMe = false
    else if (clsList.includes('item-system')) isMe = null // system message
    else if (hasStatus) isMe = true
    else if (hasAvatar) isMe = false
    else isMe = r.left > mid

    // 系统通知单独归类：优先用精确 class；只有 class/状态/头像都没有、只能靠几何
    // 位置猜的气泡，才用（锚定开头的）系统文案兜底，避免 HR 正文里提到「撤回」被误判
    const geometryOnly =
      !clsList.includes('item-myself') && !clsList.includes('item-friend') &&
      !clsList.includes('item-system') && !hasStatus && !hasAvatar
    const isSystem =
      clsList.includes('item-system') || (geometryOnly && SYSTEM_MSG_RE.test(content))
    const sender = isSystem ? 'system' : isMe ? 'me' : 'hr'
    out.push({ sender, content, kind: 'text' })
    anchors.push(el)
    // 判定依据（不含正文）：靠哪条规则判的、气泡 class、横坐标。
    // 纯 k=v 文本——带 [ / { 的 JSON 会被服务端整体脱敏，日志里就看不到依据了。
    const via = clsList.includes('item-myself') || clsList.includes('item-friend') || clsList.includes('item-system')
      ? 'class'
      : hasStatus ? 'status' : hasAvatar ? 'avatar' : 'geometry'
    const bubbleCls = clsList.filter((c) => /^item-/.test(c)).join('+') || '-'
    dbg.push(
      `msg sender=${sender} kind=text via=${via} bubble=${bubbleCls} ` +
        `x=${Math.round(r.left)} length=${content.length}`,
    )
  }

  // 交互卡片（HR 索要简历/交换联系方式/确认地点…）没有 span.text-content，
  // 上面那轮收不到。按气泡收：同一气泡里已有文本消息的跳过，避免重复。
  let orphanButtons = 0
  let orphanChain = ''
  const seenBubbles = new Set<Element>()
  for (const bubble of Array.from(panel.querySelectorAll('.item-friend, .item-myself, .item-system')) as HTMLElement[]) {
    if (seenBubbles.has(bubble)) continue
    seenBubbles.add(bubble)
    if (firstMatch(SEL.msgText, bubble)) continue
    const r = bubble.getBoundingClientRect()
    if (r.width === 0) continue
    const clsList = Array.from(bubble.classList)
    const sender: ChatMessage['sender'] = clsList.includes('item-system')
      ? 'system'
      : clsList.includes('item-myself') ? 'me' : 'hr'
    // 系统提示要看全文：「您的附件简历 261011 已发送给Boss点击查看附件」——
    // cardText 只取叶子会丢掉前半句，agent 就看不出「发了什么」。
    const content = (sender === 'system'
      ? (bubble.textContent || '').replace(/\s+/g, ' ').trim()
      : cardText(bubble)
    ).slice(0, 300)
    if (!content) continue
    // 卡片类型沿用自动处理时的同一套判据，读和点不会各判一套
    const cardKind = classifyCard(content)
    out.push({ sender, content, kind: 'card', cardKind })
    anchors.push(bubble)
    dbg.push(
      `msg sender=${sender} kind=card card_kind=${cardKind} via=class ` +
        `bubble=${clsList.filter((c) => /^item-/.test(c)).join('+')} ` +
        `x=${Math.round(r.left)} length=${content.length}`,
    )
  }
  // 兜底取证：消息区里有「同意/拒绝」按钮却不在任何已识别气泡里，说明卡片结构变了
  for (const btn of Array.from(panel.querySelectorAll('*')) as HTMLElement[]) {
    if (btn.children.length || !/^(同意|拒绝)$/.test((btn.textContent || '').trim())) continue
    if (!btn.closest('.item-friend, .item-myself, .item-system')) {
      orphanButtons++
      // 第一次取证：按钮不在任何已知气泡里，说明卡片结构变了。
      // 记标签链（不含文案），下次据此适配选择器。
      if (!orphanChain) {
        const parts: string[] = []
        let cur: HTMLElement | null = btn
        for (let i = 0; i < 5 && cur && cur !== panel; i++) {
          const cls = Array.from(cur.classList).slice(0, 2).map((c) => c.slice(0, 20)).join('.')
          parts.push(cls ? `${cur.tagName.toLowerCase()}.${cls}` : cur.tagName.toLowerCase())
          cur = cur.parentElement
        }
        orphanChain = parts.join(' < ')
      }
    }
  }

  // 两轮收集后恢复页面上的先后顺序
  const order = anchors.map((a, i) => ({ a, i }))
  order.sort((x, y) =>
    x.a === y.a ? 0 : x.a.compareDocumentPosition(y.a) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  )
  const sorted = order.map(({ i }) => out[i])
  const sortedDbg = order.map(({ i }, n) => dbg[i].replace(/^msg /, `msg index=${n} `))
  out.splice(0, out.length, ...sorted)
  dbg.splice(0, dbg.length, ...sortedDbg)
  const counts = {
    hr: out.filter((m) => m.sender === 'hr').length,
    me: out.filter((m) => m.sender === 'me').length,
    system: out.filter((m) => m.sender === 'system').length,
  }
  const geometryCount = dbg.filter((l) => l.includes('via=geometry')).length
  const cards = out.filter((m) => m.kind === 'card')
  const kinds = (k: string) => cards.filter((m) => m.cardKind === k).length
  diag(
    'CHAT',
    `消息判定 total=${out.length} hr=${counts.hr} me=${counts.me} system=${counts.system} ` +
      // 键名不能写成 resume=/content= 这类：服务端 _KEYED_SECRET 会把这些整段打码
      `cards=${cards.length} resumeCard=${kinds('resume_request')} locationCard=${kinds('location_confirm')} ` +
      `contactCard=${kinds('contact_exchange')} unknownCard=${kinds('unknown')} ` +
      `geometry=${geometryCount} orphanButtons=${orphanButtons} ` +
      `orphanChain=${orphanChain || '-'} mid=${Math.round(mid)}`,
  )
  if (opts.verbose) for (const line of dbg.slice(0, 40)) diag('CHAT', line)
  return out
}

/**
 * 定位会话头部容器。
 *
 * 以 span.position-name（岗位名）为锚点向上找：.name-text 在列表项里也有，
 * 直接 querySelector 会命中列表第一项而不是头部；岗位锚点也必须排除列表行。
 */
/** 该元素是否位于左侧会话列表项内部 */
function insideThreadList(el: HTMLElement): boolean {
  for (const sel of SEL.thread) {
    if (el.closest(sel)) return true
  }
  return false
}

/** Reuse the measured position selectors without accepting a list row as the active header. */
function headerPositionIn(root: ParentNode = document): HTMLElement | null {
  for (const selector of SEL.headerPosition) {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      if (!insideThreadList(element)) return element
    }
  }
  return null
}

/**
 * 定位右侧会话头部容器。
 *
 * 向上爬时要求容器内存在不属于列表项的 .name-text，且容器不得包含任何
 * 列表项 —— 爬到第 5、6 层时容器会大到同时包住左侧列表，导致
 * header.querySelector('.name-text') 按文档顺序拿到列表第一项的姓名。
 * 容器已经大到同时包住左侧会话列表，于是后续 header.querySelector('.name-text')
 * 按文档顺序拿到的是「列表第一项」的姓名节点——列表不重排，
 * 导致 5 个会话读出同一个公司名（且是"朱女士安徽汉威光电科技招聘者"这种拼接文本），
 * 后端全部匹配不到投递记录，5 个会话 5 个 404。
 *
 * 现在改为：向上爬时要求容器内**存在不属于列表项**的 .name-text，
 * 且容器不得包含任何列表项，越界即停在上一层。
 */
function findChatHeader(): HTMLElement | null {
  const pos = headerPositionIn()
  if (!pos) return null
  let cur: HTMLElement | null = pos.parentElement
  for (let i = 0; i < 6 && cur; i++) {
    // 一旦容器把左侧列表也圈进来，就说明爬过头了
    const swallowedList = SEL.thread.some((s) => cur!.querySelector(s))
    if (swallowedList) break
    if (headerNameIn(cur)) return cur
    cur = cur.parentElement
  }
  return pos.parentElement
}

/** 取容器内属于头部（非列表项）的姓名节点 */
function headerNameIn(root: HTMLElement): HTMLElement | null {
  const all = Array.from(root.querySelectorAll('.name-text')) as HTMLElement[]
  return all.find((el) => !insideThreadList(el)) || null
}

export function currentThreadId(): string {
  const header = findChatHeader()
  // 必须排掉列表项里的 .name-text，否则拿到的恒是列表第一项的姓名，
  // 会话指纹就永远不变 —— 切换检测（sendText 的 expectThread 核对）随之失效
  const name = text(header ? headerNameIn(header) : null)
  const pos = text(header ? headerPositionIn(header) : null)
  return `${name}|${pos}`
}

/**
 * 从会话头部读取真实的公司名与岗位名。
 *
 * 列表项把「姓名+公司+职务」拼在一起且没有岗位名，后端无法据此唯一定位
 * 投递记录；头部区域有独立的公司名节点和 span.position-name，准确得多。
 */
export function currentThreadInfo(): {
  company: string
  hrName: string
  jobTitle: string
  salary: string
  city: string
} {
  const header = findChatHeader()
  const jobTitle = text(header ? headerPositionIn(header) : null)
  // 薪资/城市取头部的，且排掉列表项里的同名 class（否则按文档顺序会
  // 拿到列表第一项的值）
  const pickHeaderField = (sels: string[]): string => {
    for (const sel of sels) {
      for (const el of Array.from(document.querySelectorAll(sel)) as HTMLElement[]) {
        if (insideThreadList(el)) continue
        const t = text(el)
        if (t) return t
      }
    }
    return ''
  }
  const salary = pickHeaderField(SEL.headerSalary)
  const city = pickHeaderField(SEL.headerCity)

  if (!header) return { company: '', hrName: '', jobTitle, salary, city }

  const nameEl = headerNameIn(header)
  const nameTxt = text(nameEl)

  // 公司名 span 无 class（dump 可见），靠位置识别：与姓名同一行、在其右侧、
  // 且排在职务标签 base-title 之前。
  let company = ''
  if (nameEl) {
    const nr = nameEl.getBoundingClientRect()
    const spans = Array.from(header.querySelectorAll('span')) as HTMLElement[]
    let best: { el: HTMLElement; x: number } | null = null
    for (const s of spans) {
      // 列表项里的 span 一律不参与：它们是「姓名+公司+职务」的拼接文本，
      // 混进来就会把整串当公司名交给后端，匹配必然失败
      if (insideThreadList(s)) continue
      const t = text(s)
      if (!t || t === nameTxt) continue
      if (s.classList.contains('name-text') || s.classList.contains('base-title')) continue
      if (s.classList.contains('position-name') || s.classList.contains('salary')) continue
      if (s.classList.contains('city') || s.classList.contains('time')) continue
      // 只认叶子节点：父级 span 的 textContent 会把子孙文本全拼进来
      if (s.querySelector('span')) continue
      const r = s.getBoundingClientRect()
      // 同一行（纵向重叠）且在姓名右侧
      const sameRow = Math.abs(r.top - nr.top) < 16
      if (!sameRow || r.left <= nr.left) continue
      if (!best || r.left < best.x) best = { el: s, x: r.left }
    }
    // 公司名可能被截断成 "盘锦市兴隆台区得..."，去掉省略号
    company = text(best?.el).replace(/[.．…]{2,}$/, '')
  }

  // 提取失败时把头部结构 dump 出来：BOSS 改版后光看
  // 「company="-"」无从下手，有这份 dump 才能改选择器
  if (!company) {
    diag('CHAT', '头部公司名提取失败，记录头部结构摘要', {
      nameLength: nameTxt.length,
      jobTitleLength: jobTitle.length,
      spans: Array.from(header.querySelectorAll('span'))
        .filter((s) => !insideThreadList(s as HTMLElement) && !(s as HTMLElement).querySelector('span'))
        .slice(0, 12)
        .map((s) => ({
          cls: String((s as HTMLElement).className || '-').slice(0, 60),
          textLength: text(s as HTMLElement).length,
        })),
    })
  }
  return { company, hrName: nameTxt, jobTitle, salary, city }
}

/**
 * 在当前会话输入并发送一条文本。
 *
 * @param expectThread 期望的会话身份指纹（currentThreadId() 的返回值）。
 *   传了就在发送前核对，不一致直接放弃 —— 防止用户中途切换会话导致发错人。
 */
async function sendText(content: string, expectThread?: string): Promise<boolean> {
  // 安全校验：会话必须还是当初读消息时那个（发给 HR 不可撤回，宁可不发）
  if (expectThread) {
    const now = currentThreadId()
    if (now !== expectThread) {
      diag('CHAT', '已中止发送：会话已被切换', {
        expectedPresent: !!expectThread,
        currentPresent: !!now,
      })
      return false
    }
  }

  // 记录发送前的列表滚动位置，发送后若被 BOSS 复位则恢复
  const container = findThreadScrollContainer()
  const savedScroll = container?.scrollTop ?? 0

  // 通用定位优先：按「可编辑元素中面积最大者」找输入框，比猜 class 稳
  const input = findEditable() || firstMatch(SEL.input)
  if (!input) {
    diag('CHAT', '发送失败：未找到输入框')
    return false
  }
  try {
    input.focus()
    await delay(150, 300)
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const ta = input as HTMLTextAreaElement
      ta.value = content
      // React 受控组件要 setter 派发才认：直接赋值会丢 valueTracker
      const proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      setter?.call(ta, content)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      input.textContent = content
      // 富文本/可编辑区：带 inputType + data 的 InputEvent 才能被 Vue/React 识别
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: content,
      }))
    }
    await delay(250, 500)

    // 发送前记下我方气泡数：新气泡是「这次发的」唯一可靠标识（文本匹配会被
    // 历史同文消息、输入框残留文字误判）。
    const baseline = countMyBubbles()

    // 发送：Enter 键盘事件（keydown+keyup，补 keyCode/which 兼容旧 handler）
    assertToolExecutionActive()
    for (const type of ['keydown', 'keyup'] as const) {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }))
    }
    await delay(400, 800)

    // 先看 Enter 是否已经发出；发出了就不要再点「发送」按钮，避免重复发送
    let via = ''
    if (countMyBubbles() > baseline) via = 'enter'
    else {
      // 兜底：找「发送」按钮（文本/aria/title/图标型，限定输入框附近，避免误点）
      const sendBtn = findSendButton(input)
      if (sendBtn) {
        assertToolExecutionActive()
        sendBtn.click()
        await delay(300, 600)
        if (countMyBubbles() > baseline) via = 'button'
      }
    }

    // 结果以 BOSS 自己给新气泡打的投递状态为准（送达/已读），不靠文本匹配：
    // 历史里有同文消息、或发送失败时输入框残留原文，文本匹配都会误判。
    const delivery = await waitForDelivery(baseline, content)
    lastSendDelivery = delivery
    // sending = 新气泡已上屏但回执未到：页面已经发出，绝不能报失败（agent 会重发）
    const ok = delivery === 'delivered' || delivery === 'read' || delivery === 'sending'
    diag(
      'CHAT',
      `send status=${delivery} via=${via || 'none'} length=${content.length} ` +
        `bubbles=${baseline}->${countMyBubbles()}`,
    )

    // 发送成功后，检查并恢复列表滚动位置
    if (ok && container) {
      await delay(400, 700) // 等 BOSS 更新列表（会话置顶动画）

      const currentScroll = container.scrollTop
      // 滚动位置被 BOSS 改动超过 100px 时恢复
      if (Math.abs(currentScroll - savedScroll) > 100) {
        diag('CHAT', '检测到列表滚动被复位，正在恢复位置', {
          saved: savedScroll,
          current: currentScroll,
          delta: currentScroll - savedScroll,
        })
        container.scrollTo({ top: savedScroll, behavior: 'instant' })
        await delay(300, 500)
      }
    }

    return ok
  } catch (e) {
    diag('CHAT', '发送异常', { errorType: (e as Error).name || 'Error' })
    return false
  }
}

/** BOSS 交互卡片：需要点按钮而非发文本 */
interface ChatCard {
  kind: 'resume_request' | 'contact_exchange' | 'location_confirm' | 'unknown'
  question: string
  acceptBtn: HTMLElement | null
  rejectBtn: HTMLElement | null
  /** 卡片容器，用于本轮立即幂等标记，避免点击后 DOM 更新前再次点击。 */
  element?: HTMLElement | null
}

/**
 * 按卡片问题文本判定类型。
 *
 * 「同意/拒绝」按钮对同时用于「要简历」和「交换联系方式」两类卡片，
 * 只看按钮会把联系方式当简历自动同意（手机号/微信会被发给垃圾招聘方）。
 * 判定必须以问题文本为准，按钮对只作为「这是个卡片」的信号；
 * 认不出来的类型一律不自动点，宁可漏也不能乱点。
 */
export function classifyCard(question: string): ChatCard['kind'] {
  const q = question.replace(/\s/g, '')
  // 联系方式必须先判：它和简历卡片共用同一对按钮，放后面会被简历分支抢走
  const contactAction = /交换|留下?|留个|提供|发送|发给|发我|给我|加个|加一下|添加/.test(q)
  const hasContact = /联系方式|手机号|手机|微信|邮箱|邮件|email|mail/.test(q)
  if (contactAction && hasContact) return 'contact_exchange'
  if (/附件简历|一份您的简历|您的简历/.test(q)) return 'resume_request'
  if (/工作地点|是否接受此工作地点/.test(q)) return 'location_confirm'
  return 'unknown'
}

/**
 * 识别当前会话里待处理的交互卡片。
 *
 * BOSS 的「索要附件简历」「确认工作地点」是带按钮的卡片而非文本消息，
 * 只发文本回复无效，必须点按钮。
 */
/**
 * 卡片是否已经答过。
 *
 * 卡片答完后按钮仍留在消息流里可点击，不加判重会把同一份简历重复发给 HR。
 * 判据：卡片垂直位置之下已有我方消息（消息流自上而下按时间排列），
 * 或结果文本已出现在消息流中。
 */
/**
 * 卡片是否已答 —— 以 BOSS 自己的状态为准：答过之后卡片按钮会被禁用。
 *
 * 2026-10-20 probe_dom 实测：
 *   已答（用户点了「可以接受」）：span.btn-v2.disabled 两个按钮都带 disabled
 *   未答（简历卡）：            span.card-btn 无任何禁用标记
 * 早期实现用「卡片下方有我方消息」判重，会把我方普通回复误当成已答；
 * 用消息文案判断也分不清「用户手打的同一句话」和「点卡片产生的结果」。
 */
function isCardAnswered(cardEl: HTMLElement, _panel: HTMLElement): boolean {
  const buttons = Array.from(
    cardEl.querySelectorAll('.card-btn, .btn-v2, [role="button"], button, span, a'),
  ).filter((el) => /^(同意|拒绝|可以接受|暂不考虑)$/.test((el.textContent || '').replace(/\s/g, '')))

  if (!buttons.length) {
    // 找不到按钮：可能是已答后被 BOSS 换成纯文本，也可能结构未知。
    // 不猜「已答」，交给上层按未知处理，避免把待处理卡片永久跳过。
    return false
  }
  return buttons.every((el) => isDialogButtonDisabled(el as HTMLElement))
}

/** 把消息区滚到底，保证卡片按钮已经渲染/可见（否则 visible() 判定为 0 会漏卡） */
async function revealLatestMessages(): Promise<void> {
  const panel = findChatPanel()
  if (!panel) return
  const anchor = firstMatch(SEL.msgText, panel) || panel
  let sc: HTMLElement | null = anchor
  for (let i = 0; i < 8 && sc; i++) {
    if (sc.scrollHeight > sc.clientHeight + 4) break
    sc = sc.parentElement
  }
  if (!sc) return
  sc.scrollTo({ top: sc.scrollHeight })
  await delay(150, 250)
}

/** 待处理卡片（会先滚动到消息底部，检测更稳定） */
export async function listPendingCardsStable(): Promise<Array<{ kind: ChatCardKind; questionLength: number }>> {
  await revealLatestMessages()
  return listPendingCardKinds()
}

function findPendingCards(): ChatCard[] {
  const panel = findChatPanel()
  if (!panel) return []

  const cards: ChatCard[] = []
  // 按钮对只用来「发现卡片」，类型一律由问题文本判定（见 classifyCard 注释：
  // 同意/拒绝 这对按钮同时用于「要简历」和「交换联系方式」，按按钮判类型
  // 会把联系方式当简历自动同意，已造成一次隐私泄露）。
  const pairs: Array<[RegExp, RegExp]> = [
    [/^同意$/, /^拒绝$/],
    [/^可以接受$/, /^暂不考虑$/],
  ]

  for (const [acceptRe, rejectRe] of pairs) {
    const accept = findByText(acceptRe, { clickable: true, root: panel })
    if (!accept) continue
    const reject = findByText(rejectRe, { clickable: true, root: panel })

    // 卡片问题文本：从按钮往上找含问句的容器，同时记下容器用于判重。
    //
    // 不能一见到「长度 6~200 的文本」就收工：按钮行本身就满足
    // （"暂不考虑可以接受" 恰好 8 字），于是取到的"问题"只有按钮文案、
    // 认不出类型。继续往上爬直到文本里出现问句特征，爬不到再退回第一个候选。
    let question = ''
    let cardEl: HTMLElement | null = null
    let fallbackQ = ''
    let fallbackEl: HTMLElement | null = null
    let cur: HTMLElement | null = accept.parentElement
    for (let i = 0; i < 6 && cur; i++) {
      const t = (cur.textContent || '').trim()
      if (t.length > 6 && t.length < 300) {
        const compact = t.replace(/\s+/g, ' ')
        if (!fallbackQ) {
          fallbackQ = compact
          fallbackEl = cur
        }
        // 问句特征：含「是否」「我想要」等，说明爬到了真正的问题容器
        if (/是否|我想要|请问|想和您|想要您/.test(compact)) {
          question = compact
          cardEl = cur
          break
        }
      }
      cur = cur.parentElement
    }
    if (!question) {
      question = fallbackQ
      cardEl = fallbackEl
    }

    const kind = classifyCard(question)

    // 已答过的卡片必须排除：BOSS 不会移除按钮，重复点会重复发给 HR
    if (cardEl && isCardAnswered(cardEl, panel)) {
      diag('CHAT', `卡片已答过，跳过（${kind}）`, { questionLength: question.length })
      continue
    }

    // 同一轮内 findPendingCards 可能在 BOSS 更新消息前再次执行；
    // 标记放在卡片容器上，避免联系方式/简历卡被重复点击。
    if (cardEl?.dataset.aahCardHandled === '1') continue
    cards.push({ kind, question, acceptBtn: accept, rejectBtn: reject, element: cardEl })
  }

  if (cards.length) {
    diag('CHAT', `发现 ${cards.length} 个交互卡片`, cards.map((c) => ({
      kind: c.kind,
      questionLength: c.question.length,
    })))
  }
  return cards
}

export interface ContactDecision {
  /** 字段存在即表示后端已给出联系方式动作。 */
  provided: boolean
  allowed: boolean | null
  channel: ReturnType<typeof normalizeContactChannel>
  /** 若后端返回此字段，必须按每张卡片的渠道逐一匹配。 */
  channels?: ContactChannel[]
  actionId: number | null
  idempotencyKey?: string
}

/**
 * 计算单张联系方式卡片是否可点击。
 * 后端返回 channels 时它是权限边界，不能只看 allowed=true；没有渠道信息
 * 时才回落到旧协议的单渠道字段或插件本地策略。
 */
export function isContactCardAllowed(
  decision: ContactDecision | null | undefined,
  channel: ContactChannel | null,
  policy: AgentPolicy | null | undefined,
): boolean {
  if (!channel) return false
  if (decision?.provided) {
    if (decision.allowed !== true) return false
    if (decision.channels) return decision.channels.includes(channel)
    if (decision.channel) return decision.channel === channel
  }
  return isContactExchangeAllowed(policy, channel)
}

/** 卡片副作用使用与后端相同的动作键，防止卡片路径绕过 Agent 策略。 */
export function isActionCardAllowed(
  policy: AgentPolicy | null | undefined,
  kind: ChatCard['kind'],
): boolean {
  if (kind === 'resume_request') return isAgentActionAllowed(policy, 'send_resume')
  if (kind === 'location_confirm') {
    // 地点卡片既会回答城市，也可能推进面试地点协商；两项都必须允许。
    return isAgentActionAllowed(policy, 'answer_city') &&
      isAgentActionAllowed(policy, 'negotiate_interview')
  }
  return true
}

/**
 * 兼容后端策略演进期的三个字段：contact_exchange / send_contact / contact，
 * 以及 actions[] 中的同名动作。字段不存在时返回 null，交给本地策略判定。
 */
function extractContactDecision(
  res: SyncChatResponse,
  actionPlan: ChatActionPlan = normalizeChatActionPlan(res),
): ContactDecision | null {
  const planned = actionPlan.contactAction
  if (planned) {
    return {
      provided: true,
      allowed: planned.allowed,
      channel: planned.channels?.length === 1 ? planned.channels[0] : null,
      channels: planned.channels,
      actionId: planned.actionId,
      idempotencyKey: planned.idempotencyKey,
    }
  }
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' ? value as Record<string, unknown> : null
  const candidates: unknown[] = [res.contact_exchange, res.send_contact, res.contact]
  if (Array.isArray(res.actions)) {
    const action = res.actions.find((item) => {
      const type = String(item.type || item.action_type || '').toLowerCase()
      return type === 'contact_exchange' || type === 'send_contact' || type === 'exchange_contact'
    })
    if (action) candidates.push(action.payload || action)
  }
  const raw = candidates.find((value) => value !== undefined && value !== null)
  if (raw === undefined) return null
  if (typeof raw === 'boolean') {
    return { provided: true, allowed: raw, channel: null, actionId: null }
  }
  const obj = record(raw)
  if (!obj) return { provided: true, allowed: null, channel: null, actionId: null }
  const mode = String(obj.action || obj.decision || '').toLowerCase()
  const explicit = typeof obj.allowed === 'boolean'
    ? obj.allowed
    : typeof obj.allow === 'boolean'
      ? obj.allow
      : mode === 'allow'
        ? true
        : false
  const idRaw = obj.contact_action_id ?? obj.contactActionId ?? obj.action_id ?? obj.actionId
  const actionId = typeof idRaw === 'number' && Number.isFinite(idRaw) ? idRaw : null
  const channels = Array.isArray(obj.channels)
    ? Array.from(new Set(obj.channels.map(normalizeContactChannel).filter((v): v is ContactChannel => !!v)))
    : undefined
  return {
    provided: true,
    allowed: explicit,
    channel: normalizeContactChannel(obj.channel ?? obj.method ?? obj.type),
    channels,
    actionId,
    idempotencyKey: typeof (obj.idempotency_key ?? obj.idempotencyKey) === 'string'
      ? String(obj.idempotency_key ?? obj.idempotencyKey)
      : undefined,
  }
}

function markCardHandled(card: ChatCard, handled = true): void {
  if (!card.element) return
  if (handled) card.element.setAttribute('data-aah-card-handled', '1')
  else card.element.removeAttribute('data-aah-card-handled')
}

export type ChatCardKind = 'resume_request' | 'contact_exchange' | 'location_confirm' | 'unknown'

/** 当前会话里待处理的交互卡片（只读，不点击）。 */
export function listPendingCardKinds(): Array<{ kind: ChatCardKind; questionLength: number }> {
  return findPendingCards().map((c) => ({ kind: c.kind, questionLength: c.question.length }))
}

/**
 * 直接点一张待处理卡片的「同意 / 拒绝」按钮（agent 工具用）。
 *
 * 不套用本地策略：回不回、同不同意由 agent 决策；这里只负责执行并记账，
 * 点击前打 handled 标记，避免同一张卡重复点。
 */
export async function clickCard(
  kind: ChatCardKind,
  accept: boolean,
  opts: { resumeName?: string | null; resumeIndex?: number | null } = {},
): Promise<boolean> {
  await revealLatestMessages()
  const card = findPendingCards().find((c) => c.kind === kind)
  if (!card) {
    diag('CHAT', `card_click status=not_found kind=${kind}`)
    return false
  }
  const btn = accept ? card.acceptBtn : card.rejectBtn
  if (!btn) {
    diag('CHAT', `card_click status=no_button kind=${kind} accept=${accept}`)
    return false
  }
  // 先占位防止并发重复点击，但失败必须回滚：标记一旦留下，findPendingCards
  // 会永远跳过这张卡，agent 再也没有重试机会（2026-10-20 实测踩到）。
  markCardHandled(card)
  const baseline = kind === 'resume_request' && accept ? countResumeSentMarks() : null
  const hit = realClick(btn)
  diag('CHAT', `card_click status=clicked kind=${kind} accept=${accept} hit=${hit}`)

  if (kind === 'resume_request' && accept) {
    await delay(1200, 2000)
    const cfg = loadConfig()
    const target =
      opts.resumeName ||
      (cfg.defaultSendResumeId && cfg.resumeNames
        ? cfg.resumeNames[String(cfg.defaultSendResumeId)] || null
        : null)
    const sent = await completeResumeSend(target, false, baseline, opts.resumeIndex ?? null)
    if (!sent) markCardHandled(card, false) // 简历没发出去 = 卡片没处理，允许重试
    diag('CHAT', `card_click resume_send status=${sent ? 'sent' : 'failed_retryable'} target=${target ? 'named' : 'none'}`)
    return sent
  }
  return true
}

/** 给当前会话发一条文本（agent 工具用），发送前核对会话未被切换。 */
export async function sendMessageText(content: string): Promise<boolean> {
  // 每次发送先清空上一次的回执：前置条件不满足直接返回时，工具层读到的
  // lastDeliveryState 必须是这次的 'none'，不能沿用上一条消息的 delivered。
  lastSendDelivery = 'none'
  const text_ = (content || '').trim()
  if (!text_) return false
  if (!onChatPage()) {
    diag('CHAT', 'send_message status=not_chat_page')
    return false
  }
  const id = currentThreadId()
  if (id === '|') {
    diag('CHAT', 'send_message status=no_thread')
    return false
  }
  return sendText(text_, id)
}

/** 最近一次 sendText 的投递结论（工具层回传给 agent：区分「确认送达」与「已发出待回执」） */
export function lastDeliveryState(): DeliveryState {
  return lastSendDelivery
}

/**
 * 处理交互卡片。
 *
 * 简历卡片一律同意（用户已授权全自动投递，索要简历是推进流程的正常环节）；
 * 工作地点是否接受取决于用户偏好城市，按配置处理；
 * 联系方式卡片按后端 Agent 策略或本地已配置渠道自动处理。没有明确策略时
 * 保持跳过；未知卡片仍然不自动点击。
 */
async function handleCard(
  card: ChatCard,
  cfg: PluginConfig,
  expectThread: string,
  log: (m: string) => void,
  contactDecision?: ContactDecision | null,
  actionPlan: ChatActionPlan = normalizeChatActionPlan({}),
): Promise<boolean> {
  // 点按钮前同样校验会话身份，防止中途切换点错人
  if (currentThreadId() !== expectThread) {
    diag('CHAT', '已中止卡片操作：会话已切换')
    return false
  }

  // A versioned backend plan is the authority for external side effects.  A
  // fact such as an interview time or city is never enough to click a card;
  // the corresponding action must be present and allowed.  Legacy responses
  // return null and continue through the v0.6.8 local-policy fallback below.
  const cardKind = card.kind === 'unknown' ? null : card.kind
  const backendPermission = cardKind ? cardActionAllowed(actionPlan, cardKind) : null
  const backendAction = cardKind ? actionForCard(actionPlan, cardKind) : null
  if (backendPermission === false) {
    log(`  ↳ ${card.kind} 未获后端动作授权 → 跳过`)
    diag('CHAT', '跳过未获后端授权的卡片动作', { kind: card.kind })
    return false
  }

  if (card.kind === 'contact_exchange') {
    const channel = contactChannelFromQuestion(card.question)
    // 后端给了动作时，以后端显式决策为准；没有动作才回落到本地策略。
    if (contactDecision?.channel && channel && contactDecision.channel !== channel) {
      log(`  ↳ HR 索要${channel}，后端动作渠道为${contactDecision.channel} → 按策略跳过`)
      diag('CHAT', '跳过联系方式交换卡片（渠道不匹配）', {
        channel,
        backendChannel: contactDecision.channel,
      })
      return false
    }
    if (!channel) {
      log('  ↳ HR 索要未识别联系方式 → 按策略跳过')
      diag('CHAT', '跳过联系方式交换卡片（未知渠道）', {
        backendDecision: contactDecision?.allowed ?? null,
        questionLength: card.question.length,
      })
      return false
    }
    const allowed = isContactCardAllowed(contactDecision, channel, cfg.agentPolicy)
    if (!allowed || !card.acceptBtn) {
      log(`  ↳ HR 索要${channel || '联系方式'} → 按策略跳过`)
      diag('CHAT', '跳过联系方式交换卡片', {
        channel,
        backendDecision: contactDecision?.allowed ?? null,
        questionLength: card.question.length,
      })
      return false
    }
    // 先写本地幂等标记，再派发点击；页面异步更新期间再次扫描也不会重复交换。
    markCardHandled(card)
    log(`  ↳ HR 索要${channel || '联系方式'} → 点「同意」`)
    realClick(card.acceptBtn)
    await delay(1200, 2000)
    diag('CHAT', '已同意交换联系方式', {
      channel,
      idempotencyKeyPresent: !!contactDecision?.idempotencyKey,
    })
    return true
  }

  // 认不出的卡片一律不点：盲点等于把未知授权交给对方
  if (card.kind === 'unknown') {
    log('  ⚠ 未识别的交互卡片 → 不自动处理，请手动查看')
    diag('CHAT', '⚠ 跳过未识别卡片（未知类型不自动点击）', {
      questionLength: card.question.length,
    })
    return false
  }

  if (card.kind === 'resume_request') {
    if (!isActionCardAllowed(cfg.agentPolicy, card.kind)) {
      log('  ↳ HR 索要附件简历 → 按 Agent 策略跳过')
      diag('CHAT', '跳过简历卡片（策略未允许发送简历）')
      return false
    }
    if (!card.acceptBtn) return false
    markCardHandled(card)
    log(`  ↳ HR 索要附件简历 → 点「同意」`)
    // The card is also handled by BOSS's delegated Vue listener. The old
    // bare click() could leave the follow-up resume picker unopened.
    const sentBaseline = countResumeSentMarks()
    realClick(card.acceptBtn)
    await delay(1200, 2000)
    diag('CHAT', '已同意发送附件简历')
    // 同意后 BOSS 弹简历选择框（多简历时）：选默认简历并发送；
    // 只有一份时直接发出，靠消息区新出现的「已发送给Boss」确认
    const resumeCfg = loadConfig()
    const targetName =
      resumeCfg.defaultSendResumeId && resumeCfg.resumeNames
        ? resumeCfg.resumeNames[String(resumeCfg.defaultSendResumeId)] || null
        : null
    const sent = await completeResumeSend(targetName, false, sentBaseline)
    if (!sent) markCardHandled(card, false)
    return sent
  }

  if (card.kind === 'location_confirm') {
    if (!isActionCardAllowed(cfg.agentPolicy, card.kind)) {
      log('  ↳ 工作地点确认 → 按 Agent 策略跳过')
      diag('CHAT', '跳过地点卡片（策略未允许城市回答或面试协商）')
      return false
    }

    // A modern plan may explicitly reject or accept the proposed location.
    // Respect that decision after the local policy gate; do not infer a click
    // from facts alone.  If no decision is supplied, retain the legacy city
    // preference behavior below.
    if (backendAction?.decision === 'reject') {
      if (!card.rejectBtn) return false
      markCardHandled(card)
      log('  ↳ 后端事实/策略判定地点不接受 → 点「暂不考虑」')
      realClick(card.rejectBtn)
      await delay(1200, 2000)
      return true
    }
    if (backendAction?.decision === 'allow') {
      if (!card.acceptBtn) return false
      markCardHandled(card)
      log('  ↳ 后端事实/策略判定地点可接受 → 点「可以接受」')
      realClick(card.acceptBtn)
      await delay(1200, 2000)
      return true
    }

    const prefCity = (cfg.prefCity || '').trim()
    const offCity = !!prefCity && !card.question.includes(prefCity)

    // 城市不符默认「接受并标记」而非拒绝：地点不该成为自动放弃机会的理由，
    // 用户可能愿意考虑。只有在设置里显式开启 rejectOffCityLocation 才拒绝。
    if (offCity && cfg.rejectOffCityLocation) {
      if (!card.rejectBtn) return false
      log('  ↳ 地点与期望城市不符，按设置拒绝')
      card.rejectBtn.click()
      await delay(1200, 2000)
      diag('CHAT', '按设置拒绝工作地点', {
        preferredCityConfigured: !!prefCity,
        questionLength: card.question.length,
      })
      return true
    }

    if (!card.acceptBtn) return false
    if (offCity) {
      // 标记：接受了但地点与期望不一致，留痕供用户复核
      log('  ↳ 工作地点确认 → 已接受（注意：与期望城市不一致）')
      diag('CHAT', '⚠ 地点与期望城市不符但已接受（未开启严格模式）', {
        preferredCityConfigured: !!prefCity,
        questionLength: card.question.length,
      })
    } else {
      log('  ↳ 工作地点确认 → 点「可以接受」')
    }
    markCardHandled(card)
    realClick(card.acceptBtn)
    await delay(1200, 2000)
    return true
  }

  return false
}

/** 按钮禁用判定（unable/disabled/aria/pointer-events） */
function isDialogButtonDisabled(el: HTMLElement): boolean {
  const cls = String(el.className || '').toLowerCase()
  let nativeDisabled = false
  try {
    // :disabled 同时覆盖 button/input/select/textarea 以及 disabled fieldset 继承。
    nativeDisabled = el.matches(':disabled')
  } catch {
    nativeDisabled = 'disabled' in el && Boolean((el as HTMLButtonElement).disabled)
  }
  return (
    nativeDisabled ||
    /unable|disabled|is-disabled|(?:^|[-_\s])disable(?:$|[-_\s])/.test(cls) ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.getAttribute('aria-busy') === 'true' ||
    getComputedStyle(el).pointerEvents === 'none'
  )
}

/** 在弹窗里找按钮：只匹配叶子节点自身文本，排除 拒绝/取消，且可见 */
export function findDialogButton(root: HTMLElement, re: RegExp): HTMLElement | null {
  const els = Array.from(root.querySelectorAll(
    'div,span,button,a,[role="button"],input[type="button"],input[type="submit"]',
  )) as HTMLElement[]
  for (const el of els) {
    const textOwn = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || '').trim())
      .join('')
    const own = (
      textOwn ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      (el instanceof HTMLInputElement ? el.value : '')
    )
      .replace(/\s+/g, '')
    if (!own || !re.test(own)) continue
    if (/拒绝|取消/.test(own)) continue
    // BOSS 常把文案放在 <button><span>发送</span></button> 内。返回 span 会
    // 漏掉 button.disabled / aria-disabled，进而点击本应禁用的发送动作。
    const action = (el.closest('button, a, [role="button"]') || el) as HTMLElement
    if (!root.contains(action)) continue
    const r = action.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return action
  }
  return null
}

/** 简历名归一化：小写、去空白/点/加号、去 .pdf 等扩展名。
 * BOSS 会用字体混淆文件名里的特殊字符（实测 "蔡韬的简历c++.pdf" 显示成 "蔡韬的简历c .pdf"），
 * 精确匹配会失败，必须归一化后做包含匹配。 */
function normResumeName(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\.(pdf|docx?|txt|jpg|jpeg|png)$/i, '')
    .replace(/[\s.+\-_]+/g, '')
}

function compactText(el: Element): string {
  return (el.textContent || '').replace(/\s+/g, '')
}

/** 元素是否真的在视口内（离屏副本宽高正常，只有位置能区分） */
function inViewport(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 &&
    r.right > 0 && r.bottom > 0 &&
    r.left < window.innerWidth && r.top < window.innerHeight
}

function isVisibleDialog(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

export function resumeDialogKind(dialog: HTMLElement): 'picker' | 'confirm' | 'unknown' {
  const t = compactText(dialog)
  if (/请选择(?:要发送的)?(?:附件)?简历|选择(?:一份)?(?:附件)?简历/.test(t)) return 'picker'
  if (/确定向Boss发送简历|该附件简历将直接发送|确认发送(?:附件)?简历/i.test(t)) return 'confirm'
  return 'unknown'
}

const RESUME_DIALOG_ACTION_RE = /^(发送|发送给Boss|发送简历|确认发送|确定发送|确定|同意|确认|继续发送)$/i

/** 定位简历弹窗：语义锚点优先，允许选择框同时带「上传简历」入口。 */
export function findResumeDialog(): HTMLElement | null {
  // 简历选择框的确定特征（2026-10-20 probe_dom 实测）：
  //   .choose-resume-dialog > .resume-choose-container > ul.resume-list > li.list-item
  //   .footer button.btn-sure-v2「发送」
  // 必须放在「多弹窗就保险退出」之前：聊天里的卡片层（.message-dialog-both /
  // .item-dialog）也会命中 [class*=dialog]，会被误当成竞争弹窗导致直接返回 null。
  const chooseDialog = findChooseResumeDialog()
  if (chooseDialog) {
    diag('CHAT', 'resume_dialog via=choose-resume')
    return chooseDialog
  }

  const cands = Array.from(document.querySelectorAll(
    '[role="dialog"], [class*="dialog"], [class*="modal"], [class*="layer"], [class*="popup"]',
  )) as HTMLElement[]
  // 同时存在多个互不包含的真实弹窗时，无法证明哪一个在最上层。即使只有
  // 一处写着“发送简历”，另一个确认/问卷弹窗也可能截获点击，必须 fail closed。
  const visibleModalContainers = cands.filter((d) =>
    isVisibleDialog(d) && (
      d.getAttribute('role') === 'dialog' ||
      d.classList.contains('active') ||
      !!findDialogButton(d, RESUME_DIALOG_ACTION_RE)
    ),
  )
  const independentVisible = visibleModalContainers.filter((candidate) =>
    !visibleModalContainers.some((other) => other !== candidate && candidate.contains(other)),
  )
  if (independentVisible.length > 1) return null
  const semantic = cands.filter((d) => {
    if (!isVisibleDialog(d)) return false
    const t = compactText(d)
    if (!t || t.length >= 2000) return false
    if (resumeDialogKind(d) === 'unknown') return false
    // `.dialog-header` 自身也会命中 [class*=dialog] 且面积更小，但它不是
    // 可操作弹窗。要求语义容器同时具备 dialog 身份/active 状态/动作按钮。
    return d.getAttribute('role') === 'dialog' ||
      d.classList.contains('active') ||
      !!findDialogButton(d, RESUME_DIALOG_ACTION_RE)
  })
  if (semantic.length) {
    // portal 外壳和内层 dialog 会同时命中；仅保留每条包含链最内层的节点。
    // 若仍有多个互不包含的可见弹窗，就无法证明哪个在最上层，安全停止。
    const innermost = semantic.filter((candidate) =>
      !semantic.some((other) => other !== candidate && candidate.contains(other)),
    )
    return innermost.length === 1 ? innermost[0] : null
  }

  // 兼容旧结构：只在 active 容器里兜底，未知普通「简历」浮层不自动操作。
  const fallback = cands.filter((d) =>
    isVisibleDialog(d) && d.classList.contains('active') && /简历/.test(d.textContent || ''),
  )
  const innermostFallback = fallback.filter((candidate) =>
    !fallback.some((other) => other !== candidate && candidate.contains(other)),
  )
  if (innermostFallback.length === 1) return innermostFallback[0]

  // 新版选择框（2026-10 实测）：标题「请选择要发送的简历」+ 附件行（文件名/更新于/大小）
  // + 「管理附件」，没有发送按钮、没有 role=dialog，上面几条规则都认不出。
  // 依次尝试：标题锚点 → 文件名锚点 → 同源 iframe 里的标题锚点。
  // 实测（2026-10-20 probe_overlays）：索要简历卡片点同意后弹出的选择框是
  // .dialog-wrap.active > .boss-popup__content > .choose-resume-dialog，
  // 附件名被字体混淆（DOM 文本里没有 .pdf），所以按文件名找必然失败。
  const known = Array.from(document.querySelectorAll(
    '.choose-resume-dialog, [class*="choose-resume"], [class*="chooseResume"]',
  )) as HTMLElement[]
  const visibleKnown = known.filter(isVisibleDialog)
  if (visibleKnown.length === 1) {
    const el = visibleKnown[0]
    const container = (el.closest('.boss-popup__content') as HTMLElement | null) || el
    diag('CHAT', 'resume_dialog via=choose-resume')
    return container
  }

  const byTitle = findResumePickerByTitle()
  if (byTitle) return byTitle
  const byFiles = findResumePickerByFiles()
  if (byFiles) {
    diag('CHAT', `resume_dialog via=files chain=${describeForLog(byFiles)}`)
    return byFiles
  }
  for (const doc of sameOriginFrames().slice(1)) {
    const t = findTitleIn(doc)
    if (t) {
      diag('CHAT', 'resume_dialog via=iframe')
      return t
    }
  }
  return null
}

/** 标签链（tag.class，不含文案），用于弹窗识别取证 */
function describeForLog(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  for (let i = 0; i < 5 && cur && cur !== document.body; i++) {
    const cls = Array.from(cur.classList).slice(0, 2).map((c) => c.slice(0, 20)).join('.')
    parts.push(cls ? `${cur.tagName.toLowerCase()}.${cls}` : cur.tagName.toLowerCase())
    cur = cur.parentElement
  }
  return parts.join(' < ')
}

/** 在指定 document 里按标题找选择框 */
function findTitleIn(doc: Document): HTMLElement | null {
  const titles = (Array.from(doc.querySelectorAll('*')) as HTMLElement[]).filter((el) => {
    if (el.children.length) return false
    if (!/^请选择(?:要发送的)?(?:附件)?简历$/.test((el.textContent || '').replace(/\s/g, ''))) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  for (const title of titles) {
    let cur: HTMLElement | null = title.parentElement
    for (let i = 0; i < 8 && cur && cur !== doc.body; i++) {
      if (countFileLeaves(cur)) return cur
      cur = cur.parentElement
    }
  }
  return null
}

/** 简历附件文件名（BOSS 附件行里的 xxx.pdf / .doc / .docx） */
const RESUME_FILE_RE = /\.(pdf|docx?|jpe?g|png)$/i

/**
 * 兜底：按「附件文件名」找选择框容器。
 *
 * 2026-10-20 实测：会话里挂着索要简历卡片时点同意/发简历，BOSS 弹出一个
 * 视觉上是浮层的选择框，但它既没有 role=dialog、class 里也没有 dialog/modal，
 * 标题兜底也没命中（findResumeDialog 返回 null，插件以为没弹窗）。
 * 这里不依赖任何 class：找可见的 .pdf/.doc 叶子，向上取「包含 1~10 个文件名」
 * 的最大容器，通常就是选择框本体。
 */
function countFileLeaves(root: Element): number {
  let n = 0
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.children.length) continue
    const t = (el.textContent || '').trim()
    if (!RESUME_FILE_RE.test(t) || t.length > 120) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) n++
    if (n > 12) return n
  }
  return n
}

function findResumePickerByFiles(): HTMLElement | null {
  const leaves = (Array.from(document.querySelectorAll('*')) as HTMLElement[]).filter((el) => {
    if (el.children.length || el.closest('.aah-root')) return false
    const t = (el.textContent || '').trim()
    if (!RESUME_FILE_RE.test(t) || t.length > 120) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  if (!leaves.length || leaves.length > 12) return null
  // 从第一个文件名往上爬，取仍然只包住这几个文件名的最大祖先
  let best: HTMLElement | null = null
  let cur: HTMLElement | null = leaves[0].parentElement
  for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
    const n = countFileLeaves(cur)
    if (n === 0 || n > 12) break
    best = cur
    cur = cur.parentElement
  }
  if (!best) return null
  const r = best.getBoundingClientRect()
  // 太小的容器（只有文件名本身）不算选择框
  if (r.width < 200 || r.height < 80) return null
  // 必须像弹层：含「发送/确定」按钮，或 class 命中 popup/dialog/layer。
  // 否则会话列表里出现过的附件名会把整个列表当成选择框（实测踩到）。
  const hasSend = !!findDialogButton(best, /^(发送|确定|确认发送)$/)
  const looksLikeLayer = /popup|dialog|layer|modal/i.test(String(best.className || ''))
  if (!hasSend && !looksLikeLayer) return null
  if (best.closest('[class*="chat-user"], [class*="user-list"], [class*="list-warp"]')) return null
  return best
}

/** 同源 iframe 的 document（BOSS 有些浮层挂在 iframe 里） */
function sameOriginFrames(): Document[] {
  const docs: Document[] = [document]
  for (const f of Array.from(document.querySelectorAll('iframe'))) {
    try {
      const d = f.contentDocument
      if (d && d !== document) docs.push(d)
    } catch {
      /* 跨域 iframe 读不到，跳过 */
    }
  }
  return docs
}

function findResumePickerByTitle(): HTMLElement | null {
  const titles = (Array.from(document.querySelectorAll('*')) as HTMLElement[]).filter((el) => {
    if (el.children.length || el.closest('.aah-root')) return false
    if (!/^请选择(?:要发送的)?(?:附件)?简历$/.test((el.textContent || '').replace(/\s/g, ''))) return false
    return isVisibleDialog(el)
  })
  const hits: HTMLElement[] = []
  for (const title of titles) {
    let cur: HTMLElement | null = title.parentElement
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      if (resumeFileLeaves(cur).length) {
        hits.push(cur)
        break
      }
      cur = cur.parentElement
    }
  }
  // 两个互不包含的可见选择框：说不清哪个在最上层，安全停止
  return hits.length === 1 ? hits[0] : null
}

/** 容器里可见的附件文件名叶子 */
function resumeFileLeaves(root: HTMLElement): HTMLElement[] {
  return (Array.from(root.querySelectorAll('*')) as HTMLElement[]).filter((el) => {
    if (el.children.length) return false
    const t = (el.textContent || '').trim()
    if (!RESUME_FILE_RE.test(t) || t.length > 120) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
}

/** 在简历选择弹窗里选目标简历：按归一化名称模糊匹配列表项，点其可点祖先；
 * 配置了目标却找不到时返回 false，由调用方安全停止，不能误发默认第一份。 */
export function selectResumeInDialog(dialog: HTMLElement, targetName: string): boolean {
  const targetNorm = normResumeName(targetName)
  if (!targetNorm) return false
  // 新版附件行（文件名 + 更新时间 + 大小，没有 radio/label）：按文件名匹配整行。
  // 点整行而不是文件名文字——文件名本身可能是「预览」链接，会打开 PDF 而不是选中。
  const fileRows = resumeFileRows(dialog)
  if (fileRows.length) {
    const scored = fileRows
      .map(({ row, name }) => {
        const norm = normResumeName(name)
        const score = norm === targetNorm ? 2 : norm.includes(targetNorm) || targetNorm.includes(norm) ? 1 : 0
        return { row, score }
      })
      .filter((x) => x.score > 0 && !isDialogButtonDisabled(x.row))
    const best = Math.max(0, ...scored.map((x) => x.score))
    const top = scored.filter((x) => x.score === best)
    if (top.length !== 1) {
      diag('CHAT', `resume_select status=${top.length ? 'ambiguous' : 'not_found'} rows=${fileRows.length} matches=${top.length}`)
      return false
    }
    const { row } = top[0]
    if (optionState(row).selected) {
      diag('CHAT', `resume_select status=already_selected rows=${fileRows.length}`)
    } else {
      // 行里有 radio/checkbox 时直接点控件：点 label 会被浏览器再转发一次给 input，
      // 行上的 Vue handler 收到两次（与下方旧版行逻辑同一处理）
      const formControl = row.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLElement | null
      if (formControl) clickDirect(formControl)
      else realClick(row)
      diag('CHAT', `resume_select status=clicked rows=${fileRows.length} score=${best} control=${formControl ? 1 : 0}`)
    }
    return true
  }
  // 只扫叶子节点（自身文本），避免父容器把整弹窗文本算进去
  const leaves = Array.from(dialog.querySelectorAll('*')) as HTMLElement[]
  const matchesByRow = new Map<HTMLElement, { score: number; delta: number }>()
  for (const el of leaves) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || '').trim())
      .join('')
    if (!own || /请选择|上传简历|发送|确定|取消/.test(own)) continue
    const norm = normResumeName(own)
    if (!norm || norm.length < 3) continue
    const exact = norm === targetNorm
    const fuzzy = norm.includes(targetNorm) ||
      (norm.length >= Math.max(4, Math.floor(targetNorm.length * 0.6)) && targetNorm.includes(norm))
    if (!exact && !fuzzy) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const ancestor = el.closest(
      '[role="radio"], [role="option"], [role="checkbox"], label, li, [data-resume-id], ' +
      '[class*="resume-item"], [class*="resume-row"], [class*="resume-card"]',
    ) as HTMLElement | null
    const row = ancestor && ancestor !== dialog && dialog.contains(ancestor) ? ancestor : el
    const formControl = row.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLElement | null
    if (isDialogButtonDisabled(row) || (formControl && isDialogButtonDisabled(formControl))) continue
    const candidate = { score: exact ? 2 : 1, delta: Math.abs(norm.length - targetNorm.length) }
    const previous = matchesByRow.get(row)
    if (!previous || candidate.score > previous.score ||
        (candidate.score === previous.score && candidate.delta < previous.delta)) {
      matchesByRow.set(row, candidate)
    }
  }
  const matches = Array.from(matchesByRow.entries())
    .map(([row, match]) => ({ row, ...match }))
    .sort((a, b) => b.score - a.score || a.delta - b.delta)

  const match = matches[0]
  if (match) {
    // 多行达到同一最高等级时，归一化已无法证明哪份才是目标（例如 C 与 C++）。
    // 简历发送不可撤回，宁可交给人工，也不能按 DOM 顺序任取第一份。
    if (matches.filter((candidate) => candidate.score === match.score).length !== 1) {
      diag('CHAT', '多个简历候选同分，安全停止发送', {
        candidateCount: matches.filter((candidate) => candidate.score === match.score).length,
        normalizedLength: targetNorm.length,
      })
      return false
    }
    const row = match.row
    // 点 label 会先触发 label.click，浏览器随后再替关联 input 触发一次 click；
    // 委托在行上的 Vue handler 因冒泡可能收到两次。存在单选/复选 input 时
    // 直接对控件派发一次，既保留 change/default activation，也避免双副作用。
    const formControl = row.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLElement | null
    const clickTarget = formControl || row
    const selectedScope = Array.from(new Set([
      row,
      clickTarget,
      ...Array.from(row.querySelectorAll('input')),
    ])) as HTMLElement[]
    const alreadySelected = selectedScope.some((node) =>
      node.getAttribute('aria-checked') === 'true' ||
      node.getAttribute('aria-selected') === 'true' ||
      (node instanceof HTMLInputElement && node.checked) ||
      /(?:^|[-_\s])(selected|active|checked|current)(?:$|[-_\s])/.test(String(node.className || '')),
    )
    // Resume rows are Vue-controlled radio/checkbox items; use the same
    // real pointer sequence as the surrounding dialog buttons.
    if (!alreadySelected) {
      if (formControl) clickDirect(formControl)
      else realClick(clickTarget)
    }
    // 简历文件名属于用户材料，不进入普通/上传日志。
    diag('CHAT', alreadySelected ? '配置的默认简历已处于选中态' : '已选择配置的默认简历', {
      normalizedLength: targetNorm.length,
    })
    return true
  }
  diag('CHAT', '弹窗里未匹配到配置的默认简历，安全停止发送', {
    normalizedLength: targetNorm.length,
    visibleOptionCount: leaves.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && !!(el.textContent || '').trim()
    }).length,
  })
  return false
}

/** 不依赖文件名的行元素（字体混淆时的兜底） */
function genericRowEls(dialog: HTMLElement): HTMLElement[] {
  const NON_ROW = /请选择|发送|取消|确定|关闭|管理附件|上传|在线简历|附件简历/
  const rows: HTMLElement[] = []
  for (const el of Array.from(dialog.querySelectorAll('[class*="resume"], [class*="item"], li, [role="radio"], label')) as HTMLElement[]) {
    if (!isVisibleDialog(el)) continue
    const r = el.getBoundingClientRect()
    if (r.height < 36 || r.width < 120) continue
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (!t || t.length < 4 || t.length > 120) continue
    if (NON_ROW.test(t)) continue
    rows.push(el)
  }
  // 只留最内层：包住别的行的容器不算一行
  return rows.filter((r) => !rows.some((o) => o !== r && r.contains(o))).slice(0, 10)
}

function listRowsGeneric(dialog: HTMLElement): ResumeOption[] {
  return genericRowEls(dialog).map((row) => ({ name: 'row', ...optionState(row) }))
}

/** 按序号点选（字体混淆导致名字不可靠时用） */
export function selectResumeRowByIndex(dialog: HTMLElement, index: number): boolean {
  const listItems = Array.from(dialog.querySelectorAll('li.list-item')) as HTMLElement[]
  const pick = listItems[index]
  if (pick) {
    if (!pick.classList.contains('selected')) realClick(pick)
    diag('CHAT', `resume_select status=clicked_list_item index=${index} rows=${listItems.length}`)
    return true
  }
  const rows = genericRowEls(dialog)
  const row = rows[index]
  if (!row) {
    diag('CHAT', `resume_select status=index_out_of_range index=${index} rows=${rows.length}`)
    return false
  }
  const input = row.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLElement | null
  if (!optionState(row).selected) {
    if (input) clickDirect(input)
    else realClick(row)
  }
  diag('CHAT', `resume_select status=clicked_by_index index=${index} rows=${rows.length}`)
  return true
}

/** picker 出现未识别的可见必填控件时，不猜字段语义，不继续发送。 */
function hasUnknownRequiredField(dialog: HTMLElement): boolean {
  const controls = Array.from(dialog.querySelectorAll(
    'input[required], select[required], textarea[required], [aria-required="true"], [contenteditable="true"][required]',
  )) as HTMLElement[]
  return controls.some((control) => {
    if (!isVisibleDialog(control) || isDialogButtonDisabled(control)) return false
    if (control.matches('input[type="radio"], input[type="checkbox"]') && control.closest(
      '[data-resume-id], [class*="resume-item"], [class*="resume-row"], [class*="resume-card"]',
    )) return false
    return true
  })
}

function dumpDialogCandidates(): string[] {
  return Array.from(document.querySelectorAll(
    '[class*="dialog"], [class*="modal"], [class*="layer"]',
  )).map((el) => {
    const r = el.getBoundingClientRect()
    return `${String(el.className || '').slice(0, 50)}[${Math.round(r.width)}x${Math.round(r.height)}]`
  }).slice(0, 10)
}

/** 简历选择框里的一行（名字只给面板显示，不进日志） */
export interface ResumeOption {
  name: string
  selected: boolean
  disabled: boolean
}

const RESUME_ROW_SEL =
  '[role="radio"], [role="option"], [role="checkbox"], label, li, [data-resume-id], ' +
  '[class*="resume-item"], [class*="resume-row"], [class*="resume-card"]'
/** 弹窗里的标题/按钮/说明文案，不是简历行 */
const RESUME_NON_OPTION_RE = /请选择|选择.*简历|上传|管理|发送|确定|确认|取消|关闭|同意|拒绝|在线简历|附件简历$|已上传附件/
/** 纯日期/大小/页数这类附属信息 */
const RESUME_META_RE = /^(\d{4}[./-]\d{1,2}[./-]\d{1,2}.*|\d+(\.\d+)?\s*(kb|mb|k|m)|\d+页|更新于.*)$/i

/**
 * 附件行：从文件名叶子往上爬，取「只包含这一个文件名」的最大祖先。
 * 新版选择框的行没有 li/label/radio，只能这样圈出整行（含更新时间和大小）。
 */
/**
 * 可见的简历选择框：优先带已选行的那个（页面里可能出现两份实例）。
 */
function findChooseResumeDialog(): HTMLElement | null {
  const cands = (Array.from(document.querySelectorAll('.choose-resume-dialog')) as HTMLElement[])
    .filter((el) => !el.closest('.aah-root') && isVisibleDialog(el))
    .filter((el) => el.querySelectorAll('li.list-item').length > 0)
    // BOSS 会保留一份离屏副本（宽高都正常，但 left/top 在视口外）。
    // 点到副本等于没点 —— 只留真正在视口里的那一份。
    .filter(inViewport)
  if (!cands.length) return null
  const withSelected = cands.filter((el) => el.querySelector('li.list-item.selected'))
  const pick = withSelected[0] || cands[cands.length - 1]
  // 标题「请选择要发送的简历」在 .boss-dialog__header 里，不在 .choose-resume-dialog 内部；
  // 返回整个 popup content，才能同时拿到标题（判类型）和「发送」按钮。
  const wrapper = pick.closest('.boss-popup__content') as HTMLElement | null
  return wrapper || pick
}

function resumeFileRows(dialog: HTMLElement): Array<{ row: HTMLElement; name: string }> {
  const leaves = resumeFileLeaves(dialog)
  return leaves.map((leaf) => {
    let row: HTMLElement = leaf
    let cur = leaf.parentElement
    while (cur && cur !== dialog && resumeFileLeaves(cur).length === 1) {
      row = cur
      cur = cur.parentElement
    }
    return { row, name: (leaf.textContent || '').trim() }
  })
}

function optionState(row: HTMLElement): { selected: boolean; disabled: boolean } {
  const input = row.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null
  const selected =
    row.getAttribute('aria-checked') === 'true' ||
    row.getAttribute('aria-selected') === 'true' ||
    !!input?.checked ||
    /(?:^|[-_\s])(selected|active|checked|current)(?:$|[-_\s])/.test(String(row.className || ''))
  return { selected, disabled: isDialogButtonDisabled(row) }
}

/**
 * 读出简历选择框里的候选行（只读，不点击）。
 *
 * 优先按附件文件名（xxx.pdf）圈行——这是 2026-10 实测的新版结构；
 * 没有文件名时退回旧版 li/label/radio 行。
 */
export function listResumeOptions(dialog: HTMLElement): ResumeOption[] {
  // 实测结构：li.list-item，.item-body 是名字/更新时间/大小，.selected 表示选中
  const listItems = Array.from(dialog.querySelectorAll('li.list-item')) as HTMLElement[]
  if (listItems.length) {
    return listItems.map((li) => {
      const body = li.querySelector('.item-body')
      const raw = (body?.textContent || li.textContent || '').replace(/\s+/g, ' ').trim()
      // 去掉「更新于 …」「xxxKB」等附属信息，只留文件名
      const name = raw.split(/更新于|\d+(?:\.\d+)?\s*(?:KB|MB|K|M)\b/i)[0].trim().slice(0, 120)
      return {
        name: name || 'row',
        selected: li.classList.contains('selected'),
        disabled: false,
      }
    })
  }
  const fileRows = resumeFileRows(dialog)
  if (fileRows.length) {
    return fileRows.map(({ row, name }) => ({ name, ...optionState(row) }))
  }
  // 附件名被字体混淆时没有 ".pdf" 字样，按结构找行：
  // 选择框内可见、高度够、文本短、可点击的行，按 DOM 顺序编号。
  const structural = listRowsGeneric(dialog)
  if (structural.length) return structural
  const rows = new Map<HTMLElement, string>()
  for (const el of Array.from(dialog.querySelectorAll('*')) as HTMLElement[]) {
    if (el.children.length) continue
    const own = (el.textContent || '').trim()
    if (!own || own.length < 2 || own.length > 80) continue
    if (RESUME_NON_OPTION_RE.test(own) || RESUME_META_RE.test(own)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const anc = el.closest(RESUME_ROW_SEL) as HTMLElement | null
    if (!anc || anc === dialog || !dialog.contains(anc)) continue
    const prev = rows.get(anc)
    if (!prev || own.length > prev.length) rows.set(anc, own)
  }
  // 嵌套行（li > label）只留最内层，避免同一份简历数两次
  const entries = Array.from(rows.entries()).filter(
    ([row]) => !Array.from(rows.keys()).some((other) => other !== row && row.contains(other)),
  )
  return entries.map(([row, name]) => ({ name, ...optionState(row) }))
}

/** 工具栏「发简历」入口。跳过消息流里 HR 卡片上的同名文字，避免误点卡片。 */
function findResumeToolbarButton(): HTMLElement | null {
  const panel = findChatPanel()
  const inCard = (el: HTMLElement): boolean =>
    !!panel && panel.contains(el) && !!el.closest('[class*="item-friend"], [class*="card"]')
  const first = findByText(/^(发简历|发送简历|附件简历)$/, { clickable: true })
  if (!first || !inCard(first)) return first
  // 第一个命中在卡片里：按文档顺序继续找卡片外的
  for (const el of Array.from(document.querySelectorAll('*')) as HTMLElement[]) {
    if (el.children.length || inCard(el) || el.closest('.aah-root')) continue
    if (!/^(发简历|发送简历|附件简历)$/.test((el.textContent || '').replace(/\s/g, ''))) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const clickable = el.closest('button, a, [role=button]') as HTMLElement | null
    return clickable || el
  }
  return null
}

/**
 * 简历发送弹窗流：确认（同意/确定）→ 选择默认简历 → 发送。
 *
 * BOSS 实际弹窗（2026-08 实测结构）：
 * 1. 确认弹窗：按钮是「同意/拒绝」卡片（不是"确定"）；
 * 2. 简历选择弹窗：多份简历时默认选中第一个，点「发送」；
 * 账号有多份简历时，按用户配置的默认简历（defaultSendResumeId）选中后发送。
 */
export async function completeResumeSend(
  targetName: string | null,
  alreadyAgreed = false,
  /** 点「发简历/同意」之前消息区里「已发送给Boss」的条数；传了才能识别「没弹窗直接发出」 */
  sentBaseline: number | null = null,
  /** 按序号选（附件名被字体混淆、无法按名字匹配时用） */
  targetIndex: number | null = null,
): Promise<boolean> {
  let agreed = alreadyAgreed
  const selectedPickers = new WeakSet<HTMLElement>()
  let waitingForEnabledLogged = false
  let sawDialog = false
  const sentNow = (): boolean => sentBaseline !== null && countResumeSentMarks() > sentBaseline
  for (let i = 0; i < 24; i++) {
    await delay(400, 600)
    const dialog = findResumeDialog()
    if (!dialog) {
      // 只有一份附件时 BOSS 不弹选择框、直接发出；选中附件行后选择框也会直接关闭。
      // 这两种情况都靠消息区新出现的「附件简历…已发送给Boss」确认，不靠弹窗。
      if (sentNow()) {
        diag('CHAT', `resume_send status=sent via=chat_mark dialog=${sawDialog}`)
        return true
      }
      continue
    }
    sawDialog = true

    const kind = resumeDialogKind(dialog)
    if (kind === 'unknown') {
      // 仅有「简历」字样的 active 浮层可能是上传表单、必填问卷或新版未知
      // 流程。不能因里面恰好有“发送”就盲点；保留结构摘要后交给人工适配。
      diag('CHAT', '发现未知简历弹窗，安全停止自动发送', {
        role: dialog.getAttribute('role') || '',
        cls: String(dialog.className || '').slice(0, 80),
        controls: dialog.querySelectorAll('button, [role="button"], input, select, textarea').length,
      })
      return false
    }
    if (kind === 'picker' && hasUnknownRequiredField(dialog)) {
      diag('CHAT', '简历选择框出现未知必填控件，安全停止自动发送', {
        requiredControlCount: dialog.querySelectorAll(
          'input[required], select[required], textarea[required], [aria-required="true"]',
        ).length,
      })
      return false
    }
    if (kind === 'picker' && !targetName && targetIndex === null) {
      // 没指定发哪份：只有一份时可以直接发；多份时 BOSS 的「当前选中」
      // 只是它自己的默认值，不代表用户意图。简历不可撤回，宁可停下交给人工。
      const options = listResumeOptions(dialog)
      if (options.length !== 1) {
        diag('CHAT', `resume_send status=ambiguous options=${options.length} target=none`)
        return false
      }
    }
    if (kind === 'picker' && targetIndex !== null && !selectedPickers.has(dialog)) {
      selectedPickers.add(dialog)
      if (!selectResumeRowByIndex(dialog, targetIndex)) return false
      await delay(350, 550)
      continue
    }
    if (kind === 'picker' && targetName && !selectedPickers.has(dialog)) {
      selectedPickers.add(dialog)
      // 先选择再判断「发送」是否禁用。BOSS 在未预选简历时会禁用按钮；
      // 旧逻辑先判 disabled，导致永远没有机会选择目标简历。
      if (!selectResumeInDialog(dialog, targetName)) return false
      await delay(350, 550)
      continue
    }

    // 发送按钮（选择弹窗/直接发送）
    const sendBtn = findDialogButton(dialog, /^(发送|发送给Boss|发送简历|确认发送|确定发送|确定)$/i)
    if (sendBtn) {
      if (isDialogButtonDisabled(sendBtn)) {
        if (!waitingForEnabledLogged) {
          waitingForEnabledLogged = true
          diag('CHAT', '简历发送按钮尚未启用，等待选择状态生效')
        }
        continue
      }
      // BOSS uses delegated Vue handlers for the portal button. A bare
      // HTMLElement.click() can update nothing even though the button is
      // visible; dispatch the same pointer/mouse sequence as a user click.
      const sendHit = realClick(sendBtn)
      const sendRect = sendBtn.getBoundingClientRect()
      diag(
        'CHAT',
        `resume_send step=click_send hit=${sendHit} disabled=${isDialogButtonDisabled(sendBtn) ? 1 : 0} ` +
          `tag=${sendBtn.tagName.toLowerCase()} ` +
          `x=${Math.round(sendRect.left)} y=${Math.round(sendRect.top)} ` +
          `inChatPanel=${!!findChatPanel()?.contains(sendBtn)}`,
      )
      // 不重试点击同一个发送按钮：第一次可能已到服务端但页面关闭稍慢，
      // 再点会重复发送。只轮询弹窗是否关闭/切到下一阶段。
      for (let wait = 0; wait < 12; wait++) {
        await delay(250, 400)
        const current = findResumeDialog()
        if (!current) {
          diag('CHAT', `已发送简历（${targetName ? '使用配置的默认简历' : '使用平台当前选中简历'}）`)
          return true
        }
        // 弹窗还没关，但消息区已经出现「已发送给Boss」= 实际已发出，
        // 不能因为弹窗动画慢就判失败（否则会重复点发送）。
        if (sentNow()) {
          diag('CHAT', 'resume_send status=sent via=chat_mark dialog_still_open=1')
          return true
        }
        if (resumeDialogKind(current) !== kind) break
      }
      const current = findResumeDialog()
      if (current && resumeDialogKind(current) === kind) {
        diag('CHAT', '已点击发送，但原简历弹窗仍在，未确认发送；不自动重复点击')
        return false
      }
      continue
    }

    // 确认弹窗：BOSS 用「同意/拒绝」，点了之后等选择弹窗
    if (!agreed) {
      const agreeBtn = findDialogButton(dialog, /^(同意|确定|确认|继续发送)$/)
      if (agreeBtn && !isDialogButtonDisabled(agreeBtn)) {
        realClick(agreeBtn)
        agreed = true
        await delay(900, 1300)
        diag('CHAT', '已点击简历确认（同意），等待选择弹窗')
      }
    }
  }
  if (sentNow()) {
    diag('CHAT', `resume_send status=sent via=chat_mark dialog=${sawDialog}`)
    return true
  }
  diag(
    'CHAT',
    `resume_send status=failed dialog=${sawDialog} baseline=${sentBaseline ?? 'none'} ` +
      `marks=${countResumeSentMarks()} candidates=${dumpDialogCandidates().length}`,
  )
  return false
}

/** 消息区里「附件简历…已发送给Boss」系统提示的条数（发送成功的确凿证据） */
export function countResumeSentMarks(): number {
  const panel = findChatPanel()
  if (!panel) return 0
  // BOSS 发简历成功后的两种系统痕迹（2026-10-20 实测）：
  //   1) 文本：「您的附件简历 xxx 已发送给Boss」
  //   2) 系统卡片链接：「点击查看附件」（新版选择框路径走的是这个）
  const MARK = /已发送给boss|点击查看附件|查看附件|对方已查看.{0,4}附件/i
  return (Array.from(panel.querySelectorAll('*')) as HTMLElement[]).filter((el) => {
    if (el.children.length) return false // 只数叶子，避免父容器重复计数
    const t = (el.textContent || '').replace(/\s/g, '')
    return MARK.test(t) && t.length <= 80
  }).length
}

/**
 * 点「发简历」→ 确认 + 选择简历 + 发送。
 *
 * @param targetName 要发的简历名（BOSS 弹窗里显示的那份）。不传则用配置的默认简历；
 *                   两者都没有且弹窗里有多份时安全停止，不发 BOSS 预选的那份。
 */
export type ResumeSendReason =
  | 'not_allowed'   // BOSS 侧暂不允许发简历（工具栏 unable、也没有索要简历卡片）
  | 'no_button'     // 找不到工具栏按钮
  | 'send_failed'   // 走了选择框但没确认发出

export interface ResumeSendOutcome {
  ok: boolean
  reason?: ResumeSendReason
}

/** sendResume 的带原因版本（工具层用它给出稳定错误码） */
export async function sendResumeDetailed(
  targetName?: string | null,
  targetIndex?: number | null,
): Promise<ResumeSendOutcome> {
  // 选择框已经开着（例如刚点过卡片同意）：直接处理它，不要再点工具栏把框关掉
  const open = findResumeDialog()
  if (open && resumeDialogKind(open) === 'picker') {
    const baseline = countResumeSentMarks()
    diag('CHAT', 'resume_send step=reuse_open_picker')
    const okReuse = await completeResumeSend(targetName || null, false, baseline, targetIndex ?? null)
    return { ok: okReuse, reason: okReuse ? undefined : 'send_failed' }
  }
  const btn = findResumeToolbarButton()
  // 有未处理的「索要简历」卡片时，工具栏「发简历」是灰的：必须走卡片上的同意
  const cardFallback = async (reason: string): Promise<boolean> => {
    const cards = listPendingCardKinds().filter((c) => c.kind === 'resume_request')
    if (!cards.length) return false
    diag('CHAT', `resume_send step=fallback_card reason=${reason}`)
    return clickCard('resume_request', true, { resumeName: targetName || null, resumeIndex: targetIndex ?? null })
  }
  if (!btn) {
    if (await cardFallback('no_toolbar_button')) return { ok: true }
    diag('CHAT', '未找到「发送简历」按钮')
    return { ok: false, reason: 'no_button' }
  }
  if (isDialogButtonDisabled(btn)) {
    diag('CHAT', '「发简历」按钮处于禁用态，尝试卡片路径', { cls: String(btn.className || '').slice(0, 60) })
    if (await cardFallback('toolbar_disabled')) return { ok: true }
    // 工具栏禁用且没有索要简历卡片 = BOSS 当前不允许给这个会话发简历
    diag('CHAT', 'resume_send status=not_allowed reason=toolbar_disabled_no_card')
    return { ok: false, reason: 'not_allowed' }
  }
  // The toolbar button is Vue-controlled as well; use the full pointer
  // sequence so the resume picker is opened in the same way as a user click.
  const baseline = countResumeSentMarks()
  realClick(btn)
  await delay(1200, 1800)

  if (targetName || targetIndex != null) {
    const ok = await completeResumeSend(targetName || null, false, baseline, targetIndex ?? null)
    return { ok, reason: ok ? undefined : 'send_failed' }
  }
  const cfg = loadConfig()
  const configured =
    cfg.defaultSendResumeId && cfg.resumeNames
      ? cfg.resumeNames[String(cfg.defaultSendResumeId)] || null
      : null
  const ok = await completeResumeSend(configured, false, baseline)
  return { ok, reason: ok ? undefined : 'send_failed' }
}

/** 兼容旧调用：只要成败 */
export async function sendResume(
  targetName?: string | null,
  targetIndex?: number | null,
): Promise<boolean> {
  return (await sendResumeDetailed(targetName, targetIndex)).ok
}

/**
 * 托管一轮会话：遍历会话 → 读消息 → 后端生成回复 → 发送 → 回报。
 *
 * @param maxThreads 本轮最多处理几个会话（防跑飞）
 */
/**
 * 会话托管并发锁（模块级）。
 *
 * 必要性：编排器与手动按钮是两个入口，若同时跑同一批会话，
 * 双方各自切换会话、各自判重，判重记录还没写回就被另一方读到旧值，
 * 结果重复发消息给 HR（不可撤回）。锁在这里而不只在 UI 隐藏按钮，
 * 是因为 UI 只能防误点，防不住状态竞争。
 */
let chatRoundRunning = false

/**
 * 停止标志。会话托管一轮要跑几十秒到几分钟，中途必须能停下来
 * ——否则用户看着它往下发消息却只能刷新页面（刷新会丢掉本轮判重记录）。
 * 只在会话之间与发送之前检查，不打断已经发出的单次动作。
 */
let chatRoundAbort = false

/** 请求停止当前轮会话托管（下一个检查点生效，不会打断正在发送的那一条） */
export function requestStopChatRound(): void {
  if (!chatRoundRunning) return
  chatRoundAbort = true
  diag('CHAT', '已收到停止请求，将在当前会话处理完后结束')
}

function shouldAbortChatRound(): boolean {
  return chatRoundAbort
}

/**
 * 按「索引 + 身份文本」重新定位会话节点。
 *
 * 缓存的引用可能已因列表重建而失效（见调用处注释）。重新定位时优先用
 * 身份文本匹配而非纯索引：BOSS 会把有新消息的会话上浮，纯索引会张冠李戴，
 * 把 A 的回复发给 B。文本对不上就宁可跳过 —— 发错不可撤回。
 */
function resolveThread(cached: ChatThread): ChatThread | null {
  if (cached.el.isConnected) return cached

  const idKey = (t: ChatThread) => `${t.company}|${t.jobTitle}`
  const want = idKey(cached)
  const byText = listThreadsQuiet().filter((t) => idKey(t) === want)

  // 只认唯一命中。
  //
  // 不做「索引兜底」：targets 已按未读排序，下标与 DOM 顺序不再对应，
  // 拿排序后的下标去索引实时列表必然错位 —— 把 A 的回复发给 B，不可撤回。
  // 身份文本重复（同公司同岗位两个 HR）时也一样宁可跳过：无从分辨谁是谁。
  if (byText.length === 1) return byText[0]

  diag('CHAT', '会话节点重新定位失败', {
    identityPresent: !!want,
    sameTextCount: byText.length,
  })
  return null
}

export async function runChatRound(
  cfg: PluginConfig,
  maxThreads = 5,
  log: (m: string) => void = () => {},
  opts: {
    mode?: 'full' | 'snapshot'
    runId?: string
    replyScope?: 'this_round' | 'all'
  } = {},
): Promise<{
  handled: number
  replied: number
  resumes_sent?: number
  pending?: number
  synced?: number
  cleaned?: number
}> {
  if (chatRoundRunning) {
    log('已有会话托管在运行，本次跳过（防止重复发消息给 HR）')
    diag('CHAT', '拒绝并发的会话托管请求')
    return { handled: 0, replied: 0 }
  }
  chatRoundRunning = true
  // 必须在这里复位而不是在 stop 里：上一轮若因 abort 结束，标志还是 true，
  // 不复位则下一轮启动即刻自杀（表现为「点了开始，一条没处理就完成了」）。
  chatRoundAbort = false
  try {
    return await runChatRoundInner(cfg, maxThreads, log, opts)
  } finally {
    chatRoundRunning = false
    chatRoundAbort = false
  }
}


/** 找输入框附近的「发送」按钮（文本/aria/title/图标 class，可见才算） */
function findSendButton(input: HTMLElement): HTMLElement | null {
  const scope = input.closest('div, section') || document
  const cands = Array.from(scope.querySelectorAll(
    'button, [role="button"], [class*="send"], [class*="Send"], [class*="btn"]',
  )) as HTMLElement[]
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, '')
    const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '')
    if (!/^发送$/.test(t) && !/发送/.test(aria)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  return null
}

/**
 * 消息投递状态（BOSS 在每条我方气泡上标的 i.message-status）。
 *
 * 2026-10-21 实测：class 为 status-delivery（文案「送达」）、status-read（「已读」）。
 * 这是 BOSS 服务端回执后才打上的标记，比「文本出现在页面上」可靠得多。
 */
export type DeliveryState = 'delivered' | 'read' | 'sending' | 'failed' | 'none'

/** 最近一次 sendText 的投递结果（供工具层回报给 agent） */
let lastSendDelivery: DeliveryState = 'none'

export function getLastSendDelivery(): DeliveryState {
  return lastSendDelivery
}

function myBubbles(): HTMLElement[] {
  const panel = findChatPanel()
  if (!panel) return []
  return Array.from(panel.querySelectorAll('.item-myself')) as HTMLElement[]
}

/** 当前会话里我方气泡数量（发送前后对比，判断是否出现了这次的新气泡） */
function countMyBubbles(): number {
  return myBubbles().length
}

/** 读一条我方气泡的投递状态 */
export function readDeliveryState(bubble: Element): DeliveryState {
  const st = bubble.querySelector('.message-status, [class*="status-"]') as HTMLElement | null
  if (!st) return 'none'
  const cls = String(st.className || '')
  const txt = (st.textContent || '').replace(/\s+/g, '')
  if (/status-read/.test(cls) || txt === '已读') return 'read'
  if (/status-delivery|status-deliver|status-sent/.test(cls) || txt === '送达') return 'delivered'
  if (/fail|error/.test(cls) || /失败|重发/.test(txt)) return 'failed'
  if (/sending|loading|pending/.test(cls) || /发送中/.test(txt)) return 'sending'
  return 'none'
}

/**
 * 等这次发送的新气泡出现并拿到 BOSS 的投递回执。
 *
 * 事件驱动（MutationObserver），不是固定轮询：气泡/状态一变化立刻判定，
 * 最长等 timeoutMs。返回：
 *   delivered/read — BOSS 已回执，确定发出
 *   sending        — 新气泡出现了但还没回执（页面已发出，结果待定，不能重发）
 *   failed         — BOSS 标了发送失败
 *   none           — 没出现新气泡（确定没发出去）
 */
async function waitForDelivery(baseline: number, content: string, timeoutMs = 8000): Promise<DeliveryState> {
  const needle = content.replace(/\s+/g, '').slice(0, 12)
  // 这次的新气泡：排在 baseline 之后、且文本吻合的那一条（防止 HR 同时发消息干扰）
  const pick = (): HTMLElement | null => {
    const fresh = myBubbles().slice(baseline)
    for (let i = fresh.length - 1; i >= 0; i--) {
      const t = (fresh[i].textContent || '').replace(/\s+/g, '')
      if (!needle || t.includes(needle)) return fresh[i]
    }
    return null
  }
  const verdict = (): DeliveryState | null => {
    const b = pick()
    if (!b) return null
    const s = readDeliveryState(b)
    if (s === 'delivered' || s === 'read' || s === 'failed') return s
    return null
  }
  const now = verdict()
  if (now) return now
  const panel = findChatPanel()
  if (!panel) return 'none'
  return new Promise<DeliveryState>((resolve) => {
    let done = false
    const finish = (s: DeliveryState): void => {
      if (done) return
      done = true
      obs.disconnect()
      clearTimeout(timer)
      resolve(s)
    }
    const obs = new MutationObserver(() => {
      const v = verdict()
      if (v) finish(v)
    })
    // 状态是改 class/文案，不只是增删节点，所以三类变化都要监听
    obs.observe(panel, { childList: true, subtree: true, attributes: true, characterData: true })
    // 超时：有新气泡但没回执 = sending（已发出、结果待定）；没有新气泡 = none
    const timer = setTimeout(() => finish(pick() ? 'sending' : 'none'), timeoutMs)
  })
}


/**
 * 会话身份键：用于跨滚动窗口去重（虚拟列表节点会被复用，引用不可靠）
 *
 * 优先用 BOSS 原生 ID（data-user-id / data-conversation-id 等属性），
 * 缺失时降级为公司名 + 岗位名（文本可能被截断，不如原生 ID 稳定）。
 */
let warnedThreadKeyFallback = false

function threadKey(t: ChatThread): string {
  // 尝试从 DOM 元素及其子节点提取 BOSS 的唯一标识
  const bossId = t.bossId || readBossId(t.el)

  if (bossId) {
    diag('CHAT', 'threadKey 使用原生ID', { idLength: bossId.length })
    return `boss:${bossId}`
  }

  // 降级：使用文本标识
  const fallback = `${t.company}|${t.jobTitle}`.replace(/\s+/g, '')
  // 只在第一次使用文本键时警告（避免刷屏）
  if (!warnedThreadKeyFallback) {
    diag('CHAT', 'threadKey 未找到原生ID，使用文本键（可能不稳定）', {
      keyLength: fallback.length,
    })
    warnedThreadKeyFallback = true
  }
  return fallback
}

// ============ 零滚动数据源（方案 C）：virtual-list.dataSources = 完整会话列表 ============
//
// 探测结论（2026-08-06 tag=STORE）：BOSS 聊天页的虚拟列表组件（vue-virtual-scroll-list，
// 组件名 virtual-list）的 $props.dataSources 保存全部会话对象（67 条），每项自带
// encryptJobId / unreadCount / lastText / lastTS / brandName / positionName 等字段。
// 因此可以：一次内存读取枚举全部会话（不滚动）；需要处理的会话用 scrollToIndex 直达，
// 只渲染/只打开目标行。组件名或字段变动时 readChatSources() 返回 null，自动回落滚动方案。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyVm = any

/** 从任意会话行向上找 virtual-list 组件实例。 */
function findVirtualListVm(): AnyVm | null {
  const row = document.querySelector<HTMLElement>(SEL.thread.join(','))
  if (!row) return null
  let vm: AnyVm = (row as AnyVm).__vue__
  for (let i = 0; i < 12 && vm; i++) {
    const name = vm.$options?.name || vm.$options?._componentTag || ''
    if (name === 'virtual-list') return vm
    vm = vm.$parent
  }
  return null
}

interface ChatSourceItem {
  boss: AnyVm
  index: number
}

/** 读取完整会话列表（零滚动）。拿不到（组件改名/未在聊天页）返回 null。 */
function readChatSources(): ChatSourceItem[] | null {
  const vl = findVirtualListVm()
  const sources = vl?.$props?.dataSources
  if (!Array.isArray(sources) || sources.length === 0) return null
  return sources.map((boss: AnyVm, index: number) => ({ boss, index }))
}

/** 按完整会话列表统计未读（不依赖哪些行恰好渲染在 DOM 里）。 */
export function threadUnreadFromSources(): {
  threads: number
  unreadThreads: number
  unreadMessages: number
} | null {
  const sources = readChatSources()
  if (!sources) return null
  let unreadThreads = 0
  let unreadMessages = 0
  for (const { boss } of sources) {
    const n = Number(boss?.unreadCount || 0)
    if (n > 0) {
      unreadThreads++
      unreadMessages += n
    }
  }
  return { threads: sources.length, unreadThreads, unreadMessages }
}

/** 让虚拟列表渲染到指定下标（优先原生 scrollToIndex，退化为 scrollToOffset / 容器滚动）。 */
async function scrollToSourceIndex(vl: AnyVm, index: number): Promise<void> {
  if (typeof vl.scrollToIndex === 'function') {
    vl.scrollToIndex(index)
    await delay(250, 400)
    return
  }
  const estimate = Number(vl.$props?.estimateSize) || 100
  if (typeof vl.scrollToOffset === 'function') {
    vl.scrollToOffset(index * estimate)
    await delay(250, 400)
    return
  }
  const container = findThreadScrollContainer()
  if (container) {
    container.scrollTop = index * estimate
    await delay(250, 400)
  }
}

/** 渲染目标行并点击切换，返回该行（失败返回 null）。 */
async function openThreadByIndex(index: number): Promise<ChatThread | null> {
  const vl = findVirtualListVm()
  if (!vl) return null
  await scrollToSourceIndex(vl, index)
  const threads = listThreadsQuiet()
  let hit = threads.find(
    (t) => (t.el as AnyVm).__vue__?.$props?.index === index,
  )
  if (!hit) {
    hit = threads.find(
      (t) => (t.el as AnyVm).__vue__?.$parent?.$props?.index === index,
    )
  }
  if (!hit) return null
  try {
    if (!switchThreadViaVue(hit.el)) realClick(hit.el)
    await delay(250, 450)
    return hit
  } catch (e) {
    diag('CHAT', `索引切换异常 idx=${index}`, { errorType: (e as Error).name || 'Error' })
    return null
  }
}

/** boss 数据源对象 → 行匹配信息（键候选：encryptJobId / 公司 / 岗位）。 */
function bossRowInfo(boss: AnyVm): { encryptJobId: string; company: string; jobTitle: string } {
  return {
    encryptJobId: boss.encryptJobId || '',
    company: boss.brandName || boss.company || '',
    jobTitle: boss.positionName || boss.title || '',
  }
}

const normText = (s: string) => (s || '').replace(/\s+/g, '').toLowerCase()

/**
 * 计划目标是否存在于 BOSS 全量会话列表（virtual-list.dataSources）。
 *
 * 真实岗位按 encryptJobId 精确比对；inbound 会话（HR 主动打招呼建档）的
 * platform_job_id 是后端虚构的 `inbound:公司:岗位`，与 BOSS 真实 jobId 对不上，
 * 只能按公司名模糊判定存在性（与 chat-plan.findPlanTarget 同容忍度）。
 */
function planTargetInSources(p: ChatPlanTarget, sources: ChatSourceItem[]): boolean {
  const jobId = (p.encrypt_job_id || '').trim()
  if (jobId && !jobId.startsWith('inbound:')) {
    return sources.some((s) => String(s.boss.encryptJobId || '') === jobId)
  }
  const cc = normText(p.company || '')
  if (!cc) return false
  return sources.some((s) => {
    const bc = normText(String(s.boss.brandName || s.boss.company || ''))
    return !!bc && (bc.includes(cc) || cc.includes(bc))
  })
}

/**
 * 滚动会话列表并回调新出现的会话（增量遍历）。
 *
 * BOSS 会话列表是虚拟列表：DOM 恒定只有约 40 个节点，向下滚时节点被复用、
 * 只换数据，「数量稳定」和底部占位符都不能当作到底判据。把「加载」和
 * 「遍历」合成一件事：每滚一屏处理当前窗口里没见过的会话（按身份键去重），
 * 处理完再滚；终止条件是「连续 N 屏没有新身份出现」。
 *
 * @param onThread 处理单个会话，返回 'stop' 可提前终止整轮滚动
 */
async function forEachThreadScrolling(
  log: (m: string) => void,
  onThread: (t: ChatThread, seq: number) => Promise<'ok' | 'stop'>,
): Promise<void> {
  // 容器每屏重新定位：切换会话会让 BOSS 重建左侧列表，孤儿节点设
  // scrollTop 不会有任何效果。
  let container = findThreadScrollContainer()
  if (!container) {
    log('未找到会话列表滚动容器，仅处理当前已渲染的会话')
    diag('CHAT', '滚动容器查找失败，退化为单屏处理')
  } else {
    diag('CHAT', '会话列表滚动容器', {
      el: `${container.tagName.toLowerCase()}.${String(container.className || '').slice(0, 40)}`,
      scrollH: container.scrollHeight,
      clientH: container.clientHeight,
      windowCount: allMatch(SEL.thread).length,
    })
  }

  // 从列表顶部开始：scrollTop 可能被上一轮或用户操作留在中间，
  // 不显式复位会导致第 0 屏从中段开始、后续又往回滚。
  if (container) {
    container.scrollTo({ top: 0 })
    await delay(250, 400)
  }

  const seen = new Set<string>()
  let seq = 0
  // 连续 3 屏无新身份即认定到底：BOSS 偶发一屏内全是已处理会话
  // （未读上浮导致顺序变动），单屏无新增不足以判定结束。
  const EMPTY_SCREENS_TO_END = 3
  let emptyScreens = 0
  // 兜底上限，防止 BOSS 改版导致的死循环
  const MAX_SCREENS = 300

  for (let screen = 0; screen < MAX_SCREENS; screen++) {
    if (shouldAbortChatRound()) {
      diag('CHAT', '滚动遍历时收到停止指令')
      return
    }

    // 当前窗口内的会话，未读优先（同屏内调顺序，不跨屏排序 —— 跨屏排序需要
    // 先全量加载，而虚拟列表下那是做不到的）
    const windowThreads = listThreadsQuiet()
      .map((t, i) => ({ t, i }))
      .sort((a, b) => Number(b.t.unread) - Number(a.t.unread) || a.i - b.i)
      .map((x) => x.t)

    let fresh = 0
    let skippedThisScreen = 0
    for (const t of windowThreads) {
      const key = threadKey(t)
      if (!key || key === '|') {
        diag('CHAT', '跳过无效键的会话项', {
          companyPresent: !!t.company,
          jobTitlePresent: !!t.jobTitle,
        })
        continue // 身份不可辨的项跳过，避免污染去重集
      }
      if (seen.has(key)) {
        // 已处理会话只计数不逐条打日志：数百个会话的逐条日志会挤掉
        // 发送失败等更关键的诊断行（历史问题：日志被刷掉看不全）。
        skippedThisScreen++
        continue
      }

      diag('CHAT', `准备处理新会话 #${seq + 1}`, {
        keyKind: key.startsWith('boss:') ? 'native' : 'fallback',
        seenSize: seen.size,
        screen,
      })
      seen.add(key)
      fresh++
      seq++

      // 处理前重新确认节点仍在文档里：同屏内处理上一条会话
      // （切换会话）就可能让 BOSS 重建列表
      const live = t.el.isConnected ? t : resolveThread(t)
      if (!live) {
        diag('CHAT', '会话节点在处理前已失效', {
          keyKind: key.startsWith('boss:') ? 'native' : 'fallback',
        })
        continue
      }

      const r = await onThread(live, seq)
      if (r === 'stop') return
      if (shouldAbortChatRound()) return
    }

    if (fresh > 0) {
      emptyScreens = 0
      log(`已处理 ${seen.size} 个会话，继续下翻...`)
    } else {
      emptyScreens++
      if (emptyScreens >= EMPTY_SCREENS_TO_END) {
        diag('CHAT', `会话列表遍历结束：连续 ${EMPTY_SCREENS_TO_END} 屏无新会话`, {
          total: seen.size,
          screens: screen + 1,
        })
        log(`会话列表已遍历完毕（共 ${seen.size} 个）`)
        return
      }
    }
    if (skippedThisScreen > 0) {
      diag('CHAT', `本屏跳过已处理会话 ${skippedThisScreen} 个（共已见 ${seen.size}）`)
    }

    // 容器可能已被重建（处理会话时切换过），重新定位后再滚
    if (!container?.isConnected) container = findThreadScrollContainer()
    if (!container) {
      diag('CHAT', '滚动容器已失效且无法重新定位，结束遍历', { total: seen.size })
      return
    }

    // 目标位置按「已滚过的屏数」算而非「当前 scrollTop + 一屏」：
    // 切换会话后 BOSS 可能把列表 scrollTop 复位为 0，按当前值递增会
    // 从头再滚一遍，误判遍历完毕。
    const step = Math.max(1, Math.floor(container.clientHeight * 0.8)) // 留 20% 重叠防漏
    const target = step * (screen + 1)
    const maxScroll = container.scrollHeight - container.clientHeight
    if (target > maxScroll + step) {
      // 已经越过底部：不再有新内容可加载，交给 emptyScreens 收尾
      emptyScreens++
      if (emptyScreens >= EMPTY_SCREENS_TO_END) {
        diag('CHAT', '已滚过列表底部且无新会话，遍历结束', { total: seen.size, maxScroll })
        log(`会话列表已遍历完毕（共 ${seen.size} 个）`)
        return
      }
    }
    container.scrollTo({ top: Math.min(target, maxScroll) })
    await delay(350, 550) // 等虚拟列表渲染新窗口
  }

  diag('CHAT', `滚动屏数达上限 ${MAX_SCREENS}，已处理 ${seen.size} 个会话`)
  log(`⚠ 会话过多（已处理 ${seen.size} 个），剩余下轮继续`)
}

/**
 * 找会话列表的滚动容器。
 *
 * 按「实际可滚动」判定（scrollHeight 明显大于 clientHeight）：
 * BOSS 的滚动容器可能用 overlay，也可能滚动发生在更外层的祖先上，
 * 只认 overflowY 样式会找不到。
 */
function findThreadScrollContainer(): HTMLElement | null {
  const first = firstMatch(SEL.thread)
  if (!first) return null

  let cur: HTMLElement | null = first.parentElement
  let fallback: HTMLElement | null = null
  for (let i = 0; i < 10 && cur; i++) {
    const st = getComputedStyle(cur)
    const scrollable = cur.scrollHeight > cur.clientHeight + 4
    if (scrollable && /auto|scroll|overlay/.test(st.overflowY)) return cur
    // 样式没声明但实际能滚的，留作兜底（BOSS 的虚拟列表属于这种）
    if (scrollable && !fallback) fallback = cur
    cur = cur.parentElement
  }
  return fallback
}

/** 删除当前已打开的会话（头部菜单 → 确认弹窗）。 */
async function deleteCurrentThread(): Promise<boolean> {
  const header = findChatHeader()
  if (!header) {
    diag('CHAT', '清理删除：未找到会话头部')
    return false
  }
  const before = currentThreadId()
  const ok = await clickDeleteInHeaderMenu(
    header,
    () => currentThreadId() === before,
    (el) => insideThreadList(el),
  )
  if (!ok) {
    diag('CHAT', '清理删除：头部菜单未触发删除')
    return false
  }
  const confirmed = await confirmDeleteDialog()
  diag('CHAT', `清理删除：${confirmed ? '已确认删除' : '确认弹窗未出现'}`)
  return confirmed
}

// ---------- 用户活跃检测：自动删除不打扰正在手动操作的用户 ----------
let lastUserActivityAt = 0
let userActivityTracked = false

// ---------- 对账节流：collectThreadSnapshot 会滚动整份会话列表（最多 80 屏 × 500ms），
// 每轮都对账会拖慢轮询。5 分钟节流一次，既修复 DB 记账失真，又不每轮全量滚动。 ----------
const RECONCILE_INTERVAL_MS = 5 * 60_000
let lastReconcileAt = 0

function trackUserActivity(e: Event): void {
  // 只认浏览器派发的真实用户事件。
  //
  // 修复（2026-08-14）：插件自己切会话走 realClick() 派发合成 mousedown，
  // 而本函数监听的正是 mousedown —— 于是插件把自己标记成「用户正在操作」，
  // 之后 10s 窗口内每一条删除都被守卫挡掉（实测整轮 cleaned=0，日志刷
  // 「检测到用户正在操作，本轮不删除 …」）。合成事件 isTrusted=false，
  // 据此过滤即可区分「真人操作」与「插件自动化」。
  if (!e.isTrusted) return
  lastUserActivityAt = Date.now()
}

/**
 * 用户最近是否有真实交互（点击/按键/滚轮/触摸）。
 *
 * 只认「刻意的、且由真人触发的输入事件」：
 * - 不监听 mousemove（握着鼠标不动也会触发，会把自动清理永久挡住）；
 * - 不认 isTrusted=false 的合成事件（插件自身的 realClick，见 trackUserActivity）。
 *
 * 会话托管轮内自动删除前检查：用户正在手动操作时跳过本轮删除，
 * 宁可慢一轮也不抢用户正在看的会话。
 */
function userRecentlyActive(withinMs = 10_000): boolean {
  if (!userActivityTracked) {
    userActivityTracked = true
    for (const ev of ['mousedown', 'keydown', 'wheel', 'touchstart'] as const) {
      document.addEventListener(ev, trackUserActivity, { passive: true })
    }
  }
  return Date.now() - lastUserActivityAt < withinMs
}

/** 读会话行 boss 对象里的完整时间戳（虚拟列表数据源带 lastTS，比文本解析准）。 */
export function readRowLastTS(li: HTMLElement): number | null {
  const hosts = [
    li.querySelector('.gray.last-msg'),
    li.querySelector('.last-msg'),
    li.querySelector('.friend-content'),
    li,
  ].filter(Boolean) as HTMLElement[]
  for (const host of hosts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vm = (host as any).__vue__
    if (!vm) continue
    const boss = findBossObject(vm)
    if (!boss?.obj) continue
    for (const k of ['lastTS', 'lastMsgTime', 'lastMessageTime', 'lastTime', 'lastMsgTs']) {
      const v = boss.obj[k]
      const n = typeof v === 'number' ? v : typeof v === 'string' && v ? Number(v) : NaN
      if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000
    }
  }
  return null
}

/**
 * 执行后端下发的清理目标。
 *
 * 职责边界（2026-08-14 解耦）：**业务判断全部在后端**，本函数只做两件
 * 后端无法做的执行前校验 ——
 *
 *   1. 数据新鲜度：后端的判断基于 DB（插件上一轮同步的快照）。从下发计划
 *      到此刻执行之间，HR 可能又发了新消息，后端无从得知。这里比对列表行
 *      的真实时间戳与 target.last_message_at：行时间更新则说明快照已过时，
 *      本轮跳过，等下一轮后端拿到新消息重新决策。
 *   2. 用户活跃：用户正在手动操作时不抢他正在看的会话。
 *
 * 这两条都不含业务语义（不判断 HR 说了什么、该不该删）。
 *
 * 此前这里有一道「最后一条必须是我方」的校验 —— 那是业务判断，放在插件端
 * 会推翻后端结论：HR 说完「好的，我这边先筛选一下」就没下文时最后一条是 HR，
 * 于是这类会话永远删不掉（实测 285 个会话 279 个卡在该规则，后端明明已判
 * status=ended 并下发 cleanup）。它已被上面的新鲜度校验取代 —— 后者能覆盖
 * 原本要防的「HR 刚回了新消息」，且不会误伤 HR 收尾的会话。
 */
async function maybeCleanupThread(
  cfg: PluginConfig,
  t: ChatThread,
  log: (m: string) => void,
  dbLastMessageAt: number | null,
  opened = false,
  planJobId = '',
  reason = 'aged_no_reply',
): Promise<number> {
  if (userRecentlyActive((cfg.cleanupGuardSeconds ?? 3) * 1000)) {
    diag('CHAT', '清理跳过：用户正在手动操作')
    log('  ↳ 检测到用户正在操作，本轮不删除目标会话')
    return 0
  }

  // 数据新鲜度校验：行时间戳晚于后端决策依据 → DB 快照已过时，本轮不删。
  // 容差 60s：BOSS 行时间与 DB 落库时间本身有秒级偏差，不算「新消息」。
  const rowTs = readRowLastTS(t.el)
  if (rowTs && dbLastMessageAt) {
    const driftMs = rowTs - dbLastMessageAt * 1000
    if (driftMs > 60_000) {
      diag('CHAT', `清理跳过：列表行有更新的消息（后端快照已过时）`, {
        driftSeconds: Math.round(driftMs / 1000),
      })
      log('  ↳ 目标会话有新消息，本轮不删除（等后端重新判定）')
      return 0
    }
  }

  if (!opened) {
    // 切「本行」而非按公司名文本匹配：文本匹配可能打开同公司的另一条会话
    let ok = false
    try {
      if (!switchThreadViaVue(t.el)) realClick(t.el)
      ok = true
    } catch (e) {
      diag('CHAT', '清理打开会话异常', { errorType: (e as Error).name || 'Error' })
    }
    await delay(250, 450)
    if (!ok) return 0
  }
  // 删除前仅保留不可逆还原的统计摘要；原始消息只走受控业务接口。
  logChatHistory(t, await readMessages())
  diag('CHAT', '清理会话', { reasonLength: reason.length })
  log('  ↳ 删除目标会话（后端策略）')
  if (await deleteCurrentThread()) {
    await afterConversationDeleted(t.company, t.jobTitle, reason, {
      encryptJobId: planJobId,
    })
    return 1
  }
  return 0
}

// processFollowUpThread 已删除（2026-08-14）：主动跟进整体移除。
// HR 已读不回本身就是答案，追问「岗位还在招吗」拿不到信息且构成骚扰；
// 后端不再下发 follow_up 目标，此函数无调用方。

/** 策略删除当前已打开的会话：用户活跃守卫 + 删除 + 后端对账 + 面板刷新。
 *
 * 守卫窗口取 cfg.cleanupGuardSeconds（默认 3s），与 maybeCleanupThread /
 * processFollowUpThread 一致。此前这里漏传参数、退化成默认 10s，
 * 是删除被过度拦截的次要原因（主因见 trackUserActivity 的合成事件过滤）。
 */
async function strategyDeleteCurrent(
  cfg: PluginConfig,
  company: string,
  jobTitle: string,
  reason: string,
  log: (m: string) => void,
): Promise<boolean> {
  if (userRecentlyActive((cfg.cleanupGuardSeconds ?? 3) * 1000)) {
    diag('CHAT', '策略删除跳过：用户正在手动操作')
    log('  ↳ 检测到用户正在操作，本轮不删除目标会话')
    return false
  }
  if (!(await deleteCurrentThread())) {
    log('  ↳ 会话删除未确认（BOSS 端可能已无此会话）')
    return false
  }
  await afterConversationDeleted(company, jobTitle, reason)
  return true
}

/**
 * 回复流程：打开目标会话 → 读消息 → 记录对话历史 → 后端 sync 判定并生成回复 → 发送。
 * 只被「计划命中 reply / 行未读」的会话调用；其余会话一律跳过（不打开、不等待）。
 */
async function processReplyThread(
  cfg: PluginConfig,
  t: ChatThread,
  seq: number,
  log: (m: string) => void,
  opts: { runId?: string },
  replyScope: 'this_round' | 'all',
): Promise<{ synced: number; replied: number; resumesSent: number; cleaned: number }> {
  const opened = await openThread(t.company, t.jobTitle)
  await delay(250, 450)
  if (opened !== 'ok') {
    diag('CHAT', `跳过会话：无法打开（${opened}）`)
    return { synced: 0, replied: 0, resumesSent: 0, cleaned: 0 }
  }
  return processOpenedThread(cfg, t, seq, log, opts, replyScope)
}

/** 会话已打开后的完整回复流程（滚动方案与零滚动方案共用，避免重复 open）。 */
async function processOpenedThread(
  cfg: PluginConfig,
  t: ChatThread,
  seq: number,
  log: (m: string) => void,
  opts: { runId?: string },
  replyScope: 'this_round' | 'all',
): Promise<{ synced: number; replied: number; resumesSent: number; cleaned: number }> {
  // 目标会话指纹：必须在切换完成后捕获，作为发送前「仍是同一会话」的校验基准。
  // 历史 bug：在 openThread 之前捕获，expectThread 恒为上一会话，切到目标后
  // 必然失配 → 所有回复「未发送（会话已切换或发送失败）」（2026-08-05 现场）。
  const threadId = currentThreadId()

  // 读取消息：不只依赖未读标记 —— 已读未回（最后一条是 HR）同样需要回复。
  // 只以「最后一条消息是否为 HR」判定，避免漏掉用户手动读过的消息。
  const messages = await readMessages()
  // 普通日志只记录统计摘要，禁止写入会话正文。
  logChatHistory(t, messages)
  const last = messages[messages.length - 1]
  const needsReply = !!last && last.sender === 'hr'
  const hrCount = messages.filter((m) => m.sender === 'hr').length
  diag(
    'CHAT',
    `消息读取 mid=${seq}：${messages.length} 条（HR ${hrCount} / 我方 ${messages.length - hrCount}）` +
      ` needsReply=${needsReply}`,
  )

  if (!needsReply) {
    return { synced: 0, replied: 0, resumesSent: 0, cleaned: 0 }
  }

  // 读取会话信息
  const info = currentThreadInfo()
  const { company, jobTitle, salary, city } = info
  diag('CHAT', '会话归属信息已读取', {
    companyPresent: !!company,
    jobTitlePresent: !!jobTitle,
    salaryPresent: !!salary,
    cityPresent: !!city,
  })

  // 单条同步后端（完整版 sync_chat：去重/已回复判定/评分/建档）
  const res = await syncChatOne(cfg, {
    platform: 'zhipin',
    platform_job_id: '',
    company,
    job_title: jobTitle,
    // 系统通知（对方已查看简历/撤回消息等）不进后端：不是对话内容，
    // 混进去会污染意图分类与「最后一条 HR 消息」判定。
    messages: messages
      .filter((m) => m.sender !== 'system')
      .map((m) => ({
        sender: m.sender === 'hr' ? 'hr' : 'me',
        content: m.content,
        timestamp: '',
      })),
    auto_reply: true,
    // 透传用户设置的最低回复匹配分；0 或未设置时后端不过滤
    min_reply_score: cfg.minReplyScore || 0,
    salary: salary || '',
    city: city || '',
    run_id: opts.runId || '',
    reply_scope: replyScope,
  })
  if (!res) {
    log('  后端处理失败，跳过当前会话')
    return { synced: 0, replied: 0, resumesSent: 0, cleaned: 0 }
  }

  const actionPlan = normalizeChatActionPlan(res)
  diag('CHAT', '后端返回会话处理计划', {
    intent: res.intent,
    newMessages: res.new_messages,
    hasReply: !!actionPlan.replyText,
    contactAction: !!actionPlan.contactAction,
    actionTypes: actionPlan.actions.map((item) => item.type),
    factKeys: Object.keys(actionPlan.facts),
    messagePresent: !!res.message,
  })

  // 结果回填（Phase 1）：意图明确时把 HR 侧动作回传后端（面试邀约 / 被拒），
  // 供行为学习与推荐融合使用；失败静默，不影响主流程。
  if (res.intent === 'interview_invite' || res.intent === 'rejection') {
    await reportChatOutcome(cfg, {
      run_id: opts.runId || '',
      items: [{
        encrypt_job_id: '',
        company: company || t.company,
        job_title: jobTitle || t.jobTitle,
        outcome: res.intent === 'interview_invite' ? 'interview_invite' : 'rejected',
        detail: res.intent,
      }],
    })
  }

  let replied = 0
  let resumesSent = 0
  let cleaned = 0

  // 联系方式卡片不依赖文本回复：后端给出 contact action 时按其决策执行，
  // 没有该字段则按本地 agentPolicy 的已配置渠道执行。先于「无回复」分支处理，
  // 否则 HR 只索要联系方式时会被提前 return 遗漏。
  const contactDecision = extractContactDecision(res, actionPlan)
  let contactSucceeded = false
  for (const card of findPendingCards().filter((c) => c.kind === 'contact_exchange')) {
    const contactOk = await handleCard(card, cfg, threadId, log, contactDecision, actionPlan)
    if (contactOk) contactSucceeded = true
  }

  const actionId = selectChatActionId(actionPlan.replyActionId, contactDecision?.actionId)

  if (!actionPlan.replyText) {
    log('  当前会话无需回复')
    // 策略删除：低质量公司不回复删除 / 拒绝原因已采集删除（delete_after_send 且无回复）
    if (res.delete_after_send) {
      log('  ↳ 策略删除当前会话')
      if (await strategyDeleteCurrent(cfg, company || t.company, jobTitle, 'low_quality', log)) cleaned++
    }
    if (shouldReportContactOnly(false, contactSucceeded) && actionId !== null) {
      await markChatSent(cfg, actionId, true, '')
    }
    return { synced: 1, replied: 0, resumesSent: 0, cleaned }
  }

  // 简历卡优先处理（2026-08-11 实测修复）：
  // BOSS 索要简历用「同意/拒绝」卡片。若先发文字，卡片下方出现我方消息，
  // isCardAnswered 会把卡片误判为「已答过」而跳过 → 简历永远发不出去。
  // 因此先点卡片发简历，再发文字回复。
  let resumeCardHandled = false
  const resumePolicyAllowed = isActionCardAllowed(cfg.agentPolicy, 'resume_request') &&
    cardActionAllowed(actionPlan, 'resume_request') !== false
  if (actionPlan.sendResume && resumePolicyAllowed) {
    const resumeCard = findPendingCards().find((c) => c.kind === 'resume_request')
    if (resumeCard) {
      resumeCardHandled = await handleCard(resumeCard, cfg, threadId, log, null, actionPlan)
    }
  } else if (actionPlan.sendResume && !resumePolicyAllowed) {
    log('  ↳ 后端建议发送简历，但当前 Agent 策略未允许，跳过简历副作用')
  }

  // 发送回复（当前会话已打开，直接发，无需重开）
  log(`  准备发送回复（长度 ${actionPlan.replyText.length}）`)
  const ok = await sendText(actionPlan.replyText, threadId)
  if (ok) {
    replied++
    if (actionPlan.sendResume) {
      // 卡片路径已发简历则跳过；否则退回输入区「发简历」按钮路径
      let resumeOk = resumePolicyAllowed && resumeCardHandled
      if (resumePolicyAllowed && !resumeOk) resumeOk = await sendResume()
      if (!resumeOk) log('  ↳ 简历未发出，需手动处理')
      else resumesSent++
      // 简历未发出时不得标记 sent：否则后端统计会把「文本已发、简历没发」
      // 的动作也计成已发简历（历史计数虚高根因之一）。
      if (actionId !== null) {
        await markChatSent(cfg, actionId, resumeOk, resumeOk ? '' : '简历未发出')
      }
    } else if (actionId !== null) {
      await markChatSent(cfg, actionId, true, '')
    }
    // 明确被拒：后端已换成「拿信息」话术；会话保留等原因（不再发完即删），
    // 原因到达后由 rejection_reason 分支采集并删除；HR 一直不回由超时清理兜底。
    if (res.delete_after_send) {
      log('  策略删除当前会话')
      if (await strategyDeleteCurrent(cfg, company || t.company, jobTitle, 'rejection', log)) cleaned++
    }
  } else {
    log('  当前会话未发送（会话已切换或发送失败）')
    if (actionId !== null) {
      await markChatSent(cfg, actionId, false, '页面发送未确认')
    }
  }

  // 处理当前会话的交互卡片（重新检测，避免跨轮引用失效）。
  // 简历卡已在上方优先处理，这里只处理其余卡片；联系方式卡片由后端动作/策略分支处理。
  for (const card of findPendingCards()) {
    if (card.kind === 'resume_request' || card.kind === 'contact_exchange') continue
    await handleCard(card, cfg, threadId, log, null, actionPlan)
  }

  await delay(800, 1600) // 会话间间隔
  return { synced: 1, replied, resumesSent, cleaned }
}


async function runChatRoundInner(
  cfg: PluginConfig,
  maxThreads: number,
  log: (m: string) => void,
  opts: {
    mode?: 'full' | 'snapshot'
    runId?: string
    replyScope?: 'this_round' | 'all'
  },
): Promise<{
  handled: number
  replied: number
  resumes_sent?: number
  pending?: number
  synced?: number
  cleaned?: number
}> {
  let handled = 0
  let replied = 0
  let resumesSent = 0
  let cleaned = 0
  let skipped = 0
  const mode = opts.mode || 'full'

  // 回复范围：只有编排器运行时才有「本轮」概念（runId 存在）；手动开启会话托管
  // 没有本轮，一律按 all 处理，否则后端 this_round 缺 run_id 会全部拒回。
  const replyScope: 'this_round' | 'all' = opts.runId
    ? (opts.replyScope || cfg.replyScope || 'this_round')
    : 'all'

  log(
    mode === 'snapshot'
      ? `开始消息快照（后端决策待回复数，不发送）。运行中请勿手动点击会话列表。`
      : `开始处理会话（后端计划 + 未读行兜底）。运行中请勿手动点击会话列表。`,
  )
  diag('CHAT', `本轮开始 ${mode}，replyScope=${replyScope} 预算 ${maxThreads}`)

  // 0) 对账：采集当前实际列表，上报后端对账并拿到该删除的 key。
  //    采集会滚动整份列表（慢），按 RECONCILE_INTERVAL_MS 节流，避免每轮全量滚动。
  let keysToDelete: string[] = []
  const now = Date.now()
  if (now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
    try {
      const snapshot = await collectThreadSnapshot()
      if (snapshot.length > 0) {
        const reconcilePayload = snapshot.map((s) => ({
          key: s.key,
          company: s.company,
          job_title: s.jobTitle,
          unread: s.unread,
          last_ts: s.lastTS,
          last_msg_preview: s.lastMsgPreview,
        }))
        const reconcileResult = await reconcileThreads(cfg, { threads: reconcilePayload })
        keysToDelete = reconcileResult.to_delete
        diag('CHAT', `对账完成：to_delete=${keysToDelete.length} created=${reconcileResult.created} marked_deleted=${reconcileResult.marked_deleted}`)
      }
    } catch (e) {
      diag('CHAT', '对账失败，继续执行', { errorType: (e as Error).name || 'Error' })
    }
    lastReconcileAt = Date.now()
  }

  // 1) 拿后端计划：哪些会话要回复 / 要清理。失败时降级为只处理未读行，
  //    绝不回退到「逐个打开全部会话」（2026-08-06 卡聊天页 14 分钟的根因）。
  const { pending: planPending, targets: planTargets } = await loadChatPlan(cfg, { replyScope })
  // 补发上次网络失败遗留的「BOSS 端已删除」标记（自愈，避免死会话跨轮残留）
  await flushConversationDeletedMarks(cfg)
  let planReply = 0
  let planCleanup = 0
  for (const t of planTargets) {
    if (t.action === 'reply') planReply++
    else if (t.action === 'cleanup') planCleanup++
  }
  diag('CHAT', `后端计划 pending=${planPending} reply=${planReply} cleanup=${planCleanup}`)

  if (mode === 'snapshot') {
    // 快照不再滚动整个列表数未读：待回复数以后端 DB 决策为准（DOM 未读兜底
    // 由 chat_snapshot_done 事件取 max 时补上）。需要 DOM 结构时用「开始调试」按钮。
    log(`消息快照完成：待回复 ${planPending} 个（后端决策）`)
    diag('CHAT', `消息快照完成 pending=${planPending}`)
    return { handled: 0, replied: 0, pending: planPending }
  }

  log(`开始单遍处理会话（后端计划 reply=${planReply} cleanup=${planCleanup}，回复预算 ${maxThreads}）...`)
  let synced = 0
  let storeMode = false

  // 2a) 零滚动快路径（方案 C）：virtual-list.dataSources 一次拿到全部会话。
  //     全量打开核对：以「前端实际读到的最后一条消息 + 意图」为准决定回不回，
  //     不复用 DB 计划做打开过滤——DB 滞后会漏掉真实待回复（HR 在我方上次同步后
  //     又发消息）；全量打开同时把「我方已发的回复」回写 DB，让数据库自我校准。
  //     回复预算 maxThreads 只限制实际发送条数，不限制扫描。
  const sources = readChatSources()
  if (sources && sources.length > 0) {
    storeMode = true
    diag('CHAT', `零滚动数据源命中：${sources.length} 条（全量打开核对，前端实测为准）`)

    // 全量列表在手：后端计划里有、BOSS 全量列表里完全没有的目标 → BOSS 端已删，
    // 直接补标记（防止死会话残留 + 每轮重复寻找）。inbound 虚拟 jobId 用公司兜底。
    const current0 = readChatSources()
    if (current0) {
      for (const p of planTargets) {
        if (planTargetInSources(p, current0)) continue
        diag('CHAT', '计划目标在 BOSS 全量列表中不存在，按已删除补标记', {
          action: p.action,
          hasNativeJobId: !!p.encrypt_job_id && !p.encrypt_job_id.startsWith('inbound:'),
        })
        await afterConversationDeleted(p.company, p.job_title, 'boss_side_deleted', {
          encryptJobId: p.encrypt_job_id,
        })
        cleaned++
      }
    }

    for (const item of sources) {
      if (replied >= maxThreads) break   // 回复预算：限制实际发送条数
      if (shouldAbortChatRound()) break
      handled++
      // 每次处理前按会话身份（friendId/uniqueId/encryptJobId）在最新列表里重新定位：
      // 清理删除会让虚拟列表下标前移，缓存下标会点错会话（把回复发给错误的 HR）。
      const current = readChatSources()
      if (!current) break
      const live = current.find(
        (s) =>
          s.boss.uniqueId === item.boss.uniqueId ||
          s.boss.friendId === item.boss.friendId ||
          s.boss.encryptJobId === item.boss.encryptJobId,
      )
      if (!live) continue // 已被删除/未加载
      const boss = live.boss
      const unread = Number(boss.unreadCount || 0) > 0
      let target = findPlanTarget(planTargets, bossRowInfo(boss), { lenient: false })
      if (!target) {
        const loose = findPlanTarget(planTargets, bossRowInfo(boss), { lenient: true })
        if (loose?.action === 'reply') target = loose
      }
      // 计划未命中且行无未读 → 跳过，且**不打开**会话。
      //
      // 修复（2026-08-14）：此前这个判断写在 openThreadByIndex 之后，
      // 于是每轮把全部会话逐个打开、再跳过绝大多数（实测 handled=100
      // / skipped=79，一轮几分钟且常中途结束）。判断只依赖列表数据源里的
      // unreadCount 与后端计划，无需打开会话即可完成 —— 移到打开之前。
      // HR 新消息会置未读、计划也覆盖已回复目标，跳过不会漏真实待回复。
      if (!target && !unread) {
        skipped++
        continue
      }
      const t = await openThreadByIndex(live.index)
      if (!t) {
        diag('CHAT', `索引跳转失败 idx=${live.index}`)
        continue
      }
      // 对账删除：优先级最高（reconcile 返回的是精确时间戳判定后的结果）
      const key = chatTargetKey({ company: t.company, job_title: t.jobTitle, encrypt_job_id: boss.encryptJobId || '' })
      if (keysToDelete.includes(key)) {
        if (!cfg.cleanReadConversations) {
          skipped++
          continue
        }
        cleaned += await maybeCleanupThread(
          cfg, t, log, target?.last_message_at ?? null, true, boss.encryptJobId || '',
          'reconcile_timeout',
        )
        continue
      }
      // 后端计划清理（保留原有逻辑，reconcile 未覆盖的场景）
      if (target?.action === 'cleanup' && !unread) {
        if (!cfg.cleanReadConversations) {
          skipped++
          continue
        }
        cleaned += await maybeCleanupThread(
          cfg, t, log, target.last_message_at, true, target.encrypt_job_id,
          target.reason || 'aged_no_reply',
        )
        continue
      }
      const r = await processOpenedThread(cfg, t, handled, log, { runId: opts.runId }, replyScope)
      synced += r.synced
      replied += r.replied
      resumesSent += r.resumesSent
      cleaned += r.cleaned
    }
  }

  // 2b) 滚动兜底：零滚动数据源不可用（组件改名/字段变动）时，单遍滚动照旧，
  //     行 → 键 → 查计划，只打开目标行。
  if (!storeMode) await forEachThreadScrolling(log, async (t, seq) => {
    if (synced >= maxThreads) return 'stop'   // 预算用完，提前结束
    if (shouldAbortChatRound()) return 'stop'
    handled++

    // 行 → 键：优先平台岗位 ID（行内 Vue 数据，无需打开），退化为 公司|岗位 文本
    const row = readRowJobInfo(t.el)
    // 先严格匹配（jobId 精确 / 公司+岗位都命中），再宽松匹配（仅公司，只对 reply 生效）
    let target = findPlanTarget(planTargets, {
      encryptJobId: row.jobId,
      company: row.brandName || t.company,
      jobTitle: row.title || t.jobTitle,
    }, { lenient: false })
    if (!target) {
      const loose = findPlanTarget(planTargets, {
        encryptJobId: row.jobId,
        company: row.brandName || t.company,
        jobTitle: row.title || t.jobTitle,
      }, { lenient: true })
      if (loose?.action === 'reply') target = loose
    }

    // 计划未命中且行无未读 → 跳过（既不打开也不等待）
    if (!target && !t.unread) {
      skipped++
      return 'ok'
    }

    // 对账删除：优先级最高（reconcile 返回的是精确时间戳判定后的结果）
    const key = chatTargetKey({
      company: row.brandName || t.company,
      job_title: row.title || t.jobTitle,
      encrypt_job_id: row.jobId || '',
    })
    if (keysToDelete.includes(key)) {
      if (!cfg.cleanReadConversations) {
        skipped++
        return 'ok'
      }
      cleaned += await maybeCleanupThread(
        cfg, t, log, target?.last_message_at ?? null, false, row.jobId || '',
        'reconcile_timeout',
      )
      return 'ok'
    }

    // 计划命中清理：行时间校验 + 打开确认最后一条是我方 → 删除（保留原有逻辑）
    if (target?.action === 'cleanup' && !t.unread) {
      if (!cfg.cleanReadConversations) {
        skipped++
        return 'ok'
      }
      cleaned += await maybeCleanupThread(
        cfg, t, log, target.last_message_at, false, target.encrypt_job_id,
        target.reason || 'aged_no_reply',
      )
      return 'ok'
    }
    // 计划命中 reply 或未读兜底 → 打开并走完整回复流程
    const r = await processReplyThread(cfg, t, seq, log, { runId: opts.runId }, replyScope)
    synced += r.synced
    replied += r.replied
    resumesSent += r.resumesSent
    cleaned += r.cleaned
    return 'ok'
  })

  log(`单遍处理完成${storeMode ? '（零滚动）' : ''}：扫描 ${handled} 个会话（跳过 ${skipped}），同步 ${synced}，发送 ${replied} 条回复，简历 ${resumesSent} 次，清理 ${cleaned}`)
  diag('CHAT', `单遍处理完成 mode=${storeMode ? 'store' : 'scroll'} handled=${handled} skipped=${skipped} synced=${synced} replied=${replied} resumes_sent=${resumesSent} cleaned=${cleaned}`)

  return { handled, replied, resumes_sent: resumesSent, synced, cleaned }
}


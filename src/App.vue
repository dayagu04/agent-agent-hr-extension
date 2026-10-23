<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'
import type { PluginConfig, ApplyProgress, HRMessageSummary } from './types'
import { loadConfig, saveConfig, isConfigReady, applyPluginPreferences } from './config'
import { fetchPluginConfig, login } from './api'
import { detectPlatform } from './platforms/factory'
import TestTools from './TestTools.vue'
import { diag } from './logger'
import { detectNavUnread } from './nav-unread'
import { probeSearchFiltersOnce } from './search-filters'
import {
  currentThreadInfo,
  deleteThread,
  listThreads,
  onChatPage,
  openThread,
  readRowJobInfo,
} from './platforms/boss-chat'
import { setPendingOpen, takePendingOpen } from './chat-store'
import {
  flushConversationDeletedMarks,
  lookupCachedJob,
  refreshChatList,
  removeMirrorByKey,
  renderableMirror,
  updateMirrorChatIdentity,
  updateMirrorJobTitle,
  upsertMirrorFromDom,
} from './ledger'
import { getOrchestrator, resumeOrchestrator } from './orchestrator'
import { storage } from './platform-bridge'
import { VERSION_LABEL } from './version'

const platform = detectPlatform()
const config = reactive<PluginConfig>(loadConfig())
const apiEnvironmentLabel = computed(() => {
  const local = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/i.test(config.apiBase)
  return local ? '本地联调' : '服务器'
})

// ---- 悬浮球拖拽 + 位置记忆 ----
const collapsed = ref(true)
/** 悬浮球默认位（也是双击重置的目标位） */
const DEFAULT_BALL_POS = { top: 80, right: 20 }
const ballPosition = ref({ ...DEFAULT_BALL_POS })
const dragging = ref(false)

/** 悬浮球尺寸（与 .aah-ball 的 48px 对应，留 12px 余量避免贴边） */
const BALL_MARGIN = 60

/**
 * 把位置夹回当前视口内。
 *
 * 拖拽和窗口 resize 共用同一套边界：两处各算一遍必然会分叉，
 * 且 resize 后不重夹的话，缩小窗口会把球留在视口外点不到
 * （位置还会被存盘，下次打开依然在外面）。
 */
function clampBallPosition(pos: { top: number; right: number }): { top: number; right: number } {
  // 展开态按抽屉尺寸夹边：抽屉 560px 宽，若沿用悬浮球的 60px 余量，
  // 往右一拖整块面板就出了视口，标题栏和收起按钮都点不到，只能刷新页面。
  // 留 120px 可见宽度作为「还能抓回来」的把手。
  const w = collapsed.value ? BALL_MARGIN : 120
  const maxTop = Math.max(BALL_MARGIN, window.innerHeight - BALL_MARGIN)
  const maxRight = Math.max(20, window.innerWidth - w)
  return {
    top: Math.max(0, Math.min(pos.top, maxTop)),
    right: Math.max(0, Math.min(pos.right, maxRight)),
  }
}

/** resize 处理器（onUnmounted 时需按同一引用移除，故提到外层持有） */
let resizeTimer: number | undefined
function onWindowResize(): void {
  // 防抖：拖窗口边框会连续触发 resize，每次都写存储太浪费
  if (resizeTimer !== undefined) clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(async () => {
    const next = clampBallPosition(ballPosition.value)
    // 只有真被夹动了才落盘，避免无谓写入
    if (next.top !== ballPosition.value.top || next.right !== ballPosition.value.right) {
      ballPosition.value = next
      try {
        await storage.set('aah_panel_position', next)
      } catch {
        /* 存储失败不影响使用，下次 resize 会再试 */
      }
    }
  }, 200)
}

onMounted(async () => {
  // storage.get 需要显式默认值（StorageAPI 签名要求 2 个参数）
  const saved = await storage.get<{ top: number; right: number } | null>('aah_panel_position', null)
  if (saved && typeof saved === 'object' && 'top' in saved && 'right' in saved) {
    // 存的是上次窗口尺寸下的位置，本次窗口可能更小 → 先夹一次再用
    ballPosition.value = clampBallPosition(saved)
  }
  window.addEventListener('resize', onWindowResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  if (resizeTimer !== undefined) clearTimeout(resizeTimer)
  if (statsTimer !== undefined) clearInterval(statsTimer)
  if (hrTimer !== null) clearInterval(hrTimer)
  window.removeEventListener('aah:config-reload', onRemoteConfigReload)
  window.removeEventListener('aah:chat-mirror-changed', onMirrorChanged)
  if (configTimer !== undefined) clearInterval(configTimer)
})

/**
 * 拖拽起手，悬浮球与展开态标题栏共用。
 *
 * 展开态也必须能拖：抽屉 560px 宽，固定在右侧会挡住 BOSS 的会话列表和
 * 消息区，用户想看被遮住的内容只能收起面板 —— 而收起就看不到运行状态了。
 */
function onDragStart(e: MouseEvent) {
  if (e.button !== 0) return
  // 标题栏里的按钮（设置/收起）不触发拖拽，否则按下即进入拖拽、click 被吞掉
  if ((e.target as HTMLElement).closest('button')) return
  e.preventDefault()
  dragging.value = true
  const startX = e.clientX
  const startY = e.clientY
  const startTop = ballPosition.value.top
  const startRight = ballPosition.value.right

  const onMove = (me: MouseEvent) => {
    const dx = me.clientX - startX
    const dy = me.clientY - startY
    ballPosition.value = clampBallPosition({
      top: startTop + dy,
      right: startRight - dx,
    })
  }

  const onUp = async () => {
    dragging.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    await storage.set('aah_panel_position', ballPosition.value)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

async function resetBallPosition() {
  ballPosition.value = clampBallPosition({ ...DEFAULT_BALL_POS })
  await storage.set('aah_panel_position', ballPosition.value)
}

// ---- 面板状态 ----
// 单流引导式面板：登录→选简历→开始投递全部一屏呈现，不再有 Tab 切换。
// 「连接/设置」（环境、简历选择、匹配开关、退出）折叠在底部，默认收起。
const showSettings = ref(false)
/** 测试工具（内嵌）：点标题栏 🧪 打开，替代原来的独立浮窗 */
const showTests = ref(false)
/** 展开并滚动到底部的设置区（标题栏 ⚙ 与未配置引导共用） */
function gotoSettings(): void {
  showSettings.value = true
}

const resumes = ref<Array<{ id: number; name: string; skills_count: number }>>([])
const configError = ref('')
const loadingConfig = ref(false)

// 投递用关键词：优先网页端求职偏好的 keyword，其次简历提取的 suggested_keywords。
// 「开始投递」直接用它启动编排器（插件内闭环，不必去网页端点）。
const applyKeywords = ref<string[]>([])
// 投递城市编码（BOSS 数字 city code；来自网页端偏好）。为空则沿用当前页 URL 城市。
const applyCityCode = ref('')
// 「开始投递」的即时反馈（校验失败/启动提示）
const startMsg = ref('')

// 插件内登录（省去手动复制 Token）
const loginEmail = ref('')
const loginPassword = ref('')
const loggingIn = ref(false)
const loginMsg = ref('')
// 是否已从网站同步到求职偏好（用于界面提示配置来源）
const prefsSynced = ref(false)

// ---- 会话托管（BOSS 聊天页）----
/**
 * 是否在聊天页。
 *
 * 用 ref 而非 computed：onChatPage() 读的是 location.pathname，不是响应式源，
 * 包在 computed 里只会算一次并永久缓存。BOSS 是 SPA，搜索页→聊天页不会重新
 * 挂载组件，于是 isChatPage 一直是进入时的旧值——会话 Tab 的分支就判错了。
 * 改由下方 setInterval 里的 syncRouteState() 每秒重算。
 */
const isChatPage = ref(onChatPage())

/** BOSS 导航「消息」未读角标数（feedback #1：不点进去也能知道有无新消息）。
 * -1 = 未读到角标元素（可能本页无导航/选择器变了），>=0 = 实际未读数。 */
const navUnread = ref(-1)
/** 导航角标上报去重：同一页面路径只报一次结论，之后只报数值变化。 */
let navLastKey = ''
/** 当前路径已稳定几秒：导航是异步渲染的，刚换页就探测会误报「未命中」。 */
let navPathTicks = 0
let navPath = ''

/** 每秒同步一次「跟路由/存储走」的状态（SPA 换页不重新挂载，只能轮询） */
function syncRouteState(): void {
  isChatPage.value = onChatPage()
  const r = detectNavUnread()
  navUnread.value = r.count

  // BOSS 页开 DevTools 会被风控关页，只能靠自动上报核对：
  //  - 换页后等 3 秒再报，给导航渲染时间；
  //  - 每个路径报一次结论（含命中路径和脱敏结构），数值变化再报；
  //  - 未命中也报，否则日志里没有任何线索。
  const path = location.pathname
  if (path !== navPath) {
    navPath = path
    navPathTicks = 0
  }
  navPathTicks++
  if (navPathTicks < 3) return
  const key = `${path}|${r.count}|${r.via}`
  if (key === navLastKey) return
  navLastKey = key
  diag('NAV_UNREAD', `导航未读角标=${r.count} via=${r.via} path=${path} probe=${r.probe}`)
}

// ---- HR 最近消息（会话 Tab）----
// 数据来自 GET /api/conversations/list 的 last_hr_message 字段。
// 不逐条补 GET /api/conversations/{id}：那个端点会对「已分类且未回复」的消息
// 调 LLM 生成回复草稿，30s 轮询 5 条约等于每小时 600 次 LLM 调用。
const recentHRMessages = ref<HRMessageSummary[]>([])

/**
 * DOM 独有（后端还没同步过）会话的稳定临时负 id。
 * 用 公司|岗位 哈希生成，刷新/换页都不变，避免 Vue key 抖动；
 * 负数区间与后端真实 id 天然隔离，deleteHRThread 据此判断「只删页面、不进台账」。
 */
function tempDomId(company: string, jobTitle: string): number {
  const s = `${company || ''}|${jobTitle || ''}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return -(1 + (Math.abs(h) % 1_000_000_000))
}
const hrMessagesError = ref('')
const hrMessagesLoading = ref(false)
/** 是否已拉取过一次 —— 用于区分「还没拉」与「拉过但确实是空的」 */
const hrMessagesLoaded = ref(false)
/** 卡片点击后的反馈（未找到会话时提示，不用 alert 打断） */
const openThreadMsg = ref('')

const HR_REFRESH_MS = 60_000
let hrTimer: number | null = null
/** 上次成功拉取的时刻，用于非聊天页降频（见 onMounted 里的轮询门禁） */
let lastHRFetchAt = 0
/** 会话 Tab 可见时的刷新节流：切 Tab 的即时刷新与定时器去重 */
let lastChatRefreshAt = 0
/** 非聊天页的最小拉取间隔：投递页不看会话卡片，3 分钟够了 */
const HR_IDLE_INTERVAL_MS = 180_000
/** 本地镜像渲染上限（与 ledger.MAX_MIRROR 一致，覆盖「有多少显示多少」的需求） */
const HR_LIST_LIMIT = 1000

/** 公司|岗位 归一化键（与 boss-chat 的 threadKey 同思路，做 DOM ↔ 后端映射用） */
function threadDisplayKey(company: string, jobTitle: string): string {
  return `${(company || '').trim()}|${(jobTitle || '').trim()}`
}

/**
 * 聊天页：以 BOSS 页面 DOM 为真相源，合并后端镜像。
 *
 * 列表以页面 DOM 为真相源：页面有、后端还没有的新会话也要展示；
 * BOSS 已删的会话不再展示。
 *
 * 规则：
 * - DOM 有的会话 → 展示（页面为准）；匹配到后端记录则富化内容/时间/分数，未读以页面为准
 * - DOM 有、后端无（新会话/未同步）→ 用稳定负 id 展示；删除时只删页面、不进台账
 *   （后端还没有这条记录，台账无从记起，等同步后再删才会记账）
 * - DOM 无、后端有（BOSS 已删）→ 不展示
 * - DOM 完全为空（面板先于 BOSS 列表渲染）→ 回退后端列表，避免闪空
 *
 * 调用方（loadHRMessages）会把结果通过 upsertMirrorFromDom 落进本地镜像，
 * 让镜像以页面为准、后端只做富化。
 */
function mergeChatListWithDom(backendList: HRMessageSummary[]): HRMessageSummary[] {
  const dom = listThreads()
  if (dom.length === 0) return backendList

  const byKey = new Map(backendList.map((m) => [threadDisplayKey(m.company, m.jobTitle), m]))
  // 公司名兜底索引：BOSS 列表条目常把「HR名+公司」拼成一串（如 "张女士作业帮HR.招聘专员"）
  // 且提取不到岗位名，此时按「后端公司名出现在 DOM 行文本中」匹配富化；
  // 同公司多个会话时取最近消息的那条（BOSS 列表本身也只显示一个）。
  const byCompany = new Map<string, HRMessageSummary>()
  for (const m of backendList) {
    const c = (m.company || '').trim().toLowerCase()
    const cur = byCompany.get(c)
    if (!cur || m.timestamp > cur.timestamp) byCompany.set(c, m)
  }

  const next: HRMessageSummary[] = []
  for (const t of dom) {
    const key = threadDisplayKey(t.company, t.jobTitle)
    const b = byKey.get(key)
    if (b) {
      next.push({
        ...b,
        hrName: t.name || b.hrName,
        unread: t.unread,
        // 行级 BOSS 原生标识：同公司多会话时删除定位/对账不再靠公司名猜
        bossId: t.bossId || b.bossId,
      })
      continue
    }
    // 岗位名缺失 → 公司名兜底：用后端记录的岗位名/内容/分数富化，
    // 但保留 DOM 展示的公司串（含 HR 名，满足「HR名称+公司+岗位」的展示需求）
    const domText = `${t.company} ${t.jobTitle}`.toLowerCase()
    const fb = Array.from(byCompany.values()).find((m) =>
      domText.includes((m.company || '').trim().toLowerCase()),
    )
    if (fb) {
      next.push({
        ...fb,
        hrName: t.name || fb.hrName,
        company: t.company,
        unread: t.unread,
        bossId: t.bossId || fb.bossId,
      })
      continue
    }
    next.push({
      id: tempDomId(t.company, t.jobTitle),
      hrName: t.name,
      company: t.company,
      jobTitle: t.jobTitle,
      content: '',
      timestamp: 0,
      unread: t.unread,
      matchScore: null,
      bossId: t.bossId || '',
    })
  }
  // 与镜像同序（时间倒序）：会话页 / 投递页渲染同一份顺序，避免“换个页面就乱序”
  return next.sort((a, b) => b.timestamp - a.timestamp)
}

async function loadHRMessages(): Promise<void> {
  if (!ready.value) return
  lastHRFetchAt = Date.now()
  // 补发上次网络失败遗留的「BOSS 端已删除」标记（自愈对账）
  await flushConversationDeletedMarks(config)
  // 本地优先：先用本地镜像即时渲染（零等待），再后台增量拉服务器
  recentHRMessages.value = await renderableMirror()
  hrMessagesLoading.value = true
  try {
    // 拉取走增量（since 只取有变化的会话），失败时保留本地镜像渲染、仅提示
    const { list, failed } = await refreshChatList(config, HR_LIST_LIMIT)
    // 聊天页：以 BOSS 页面 DOM 为真相源对齐列表（见 mergeChatListWithDom 注释），
    // 并把结果落进本地镜像——镜像以页面为准，后端只做富化（非聊天页也渲染一致列表）
    if (isChatPage.value) {
      recentHRMessages.value = mergeChatListWithDom(list)
      await upsertMirrorFromDom(recentHRMessages.value)
    } else {
      recentHRMessages.value = list
    }
    hrMessagesLoaded.value = true
    hrMessagesError.value = failed ? '加载失败，稍后重试' : ''
  } finally {
    hrMessagesLoading.value = false
  }
}

/** 后台删除（超时清理/策略删除/对账补标）改完镜像后的事件回调：立即重渲染 */
async function onMirrorChanged(): Promise<void> {
  if (!ready.value) return
  recentHRMessages.value = await renderableMirror()
}

/** 该会话是否会被自动回复跳过，以及原因（与后端判定保持一致）。null = 不会被跳过 */
function skipInfo(msg: HRMessageSummary): { label: string; title: string } | null {
  if (msg.matchScore === null) {
    return {
      label: '未评分',
      title:
        '这个岗位没有经过匹配评分（多为 HR 主动打招呼、不是你投的），' +
        '后端无从判断是否值得回复，因此不会自动回复，需要你手动看一眼。' +
        '注意：调低「最低回复匹配分」对这类会话无效——它不是分数低，是没有分数。',
    }
  }
  if (msg.matchScore < config.minReplyScore) {
    return {
      label: `${msg.matchScore.toFixed(0)} 分 < 阈值 ${config.minReplyScore}`,
      title:
        `匹配分 ${msg.matchScore.toFixed(1)} 低于「最低回复匹配分」${config.minReplyScore}，` +
        '判定为低质量岗位，不会自动回复。想回复这类岗位就在设置页调低该阈值。',
    }
  }
  return null
}

/**
 * 点 HR 卡片 → 打开对应会话。
 *
 * 分两种情况：
 *  - 已在聊天页：直接在会话列表里定位并切换，无需跳转。
 *  - 不在聊天页：把「要打开谁」落盘，再跳转。跳转后本次 JS 上下文销毁，
 *    由聊天页重新挂载时的 consumePendingOpen() 接手（同 orchestrator 跨页续跑思路）。
 */
async function openHRThread(msg: HRMessageSummary): Promise<void> {
  openThreadMsg.value = ''
  if (!onChatPage()) {
    await setPendingOpen(msg.company, msg.jobTitle)
    diag('UI', '待打开会话已落盘，跳转聊天页')
    gotoChatPage()
    return
  }
  const r = openThread(msg.company, msg.jobTitle)
  if (r === 'ok') {
    openThreadMsg.value = `已打开「${msg.company}」的会话`
    // 列表项没有岗位名（只在打开的会话头部），打开后回填到镜像
    const info = currentThreadInfo()
    if (info.jobTitle || info.salary) {
      await updateMirrorJobTitle(msg.id, info.jobTitle, info.salary)
      recentHRMessages.value = await renderableMirror()
    }
  } else if (r === 'not-found') {
    // 常见原因：列表靠后还没加载（列表以页面 DOM 为准，理论上都在，先刷新再看）
    openThreadMsg.value = `会话列表里没找到「${msg.company}」，可能需要先向下滚动加载`
  } else {
    openThreadMsg.value = `打开「${msg.company}」失败，详见日志`
  }
}

/** 后台无感回填岗位名：读行组件 boss 对象（带 positionName），不切换会话、只读不发送 */
let backfillJobTitlesRunning = false
async function backfillChatJobTitles(): Promise<void> {
  if (backfillJobTitlesRunning || !onChatPage()) {
    return
  }
  backfillJobTitlesRunning = true
  try {
    const threads = listThreads()
    if (!threads.length) return
    let filled = 0
    for (const t of threads) {
      // 行组件数据（纯内存、极快）：岗位名/薪资/干净公司/HR名 + encryptJobId
      const info = readRowJobInfo(t.el)
      let title = info.title
      let salary = info.salary
      // boss 对象没有岗位名字段时，用 encryptJobId 查「投递扫描岗位缓存」
      // boss.encryptJobId 与投递扫描的岗位 URL id 一致
      if ((!title || !salary) && info.jobId) {
        const cached = await lookupCachedJob(info.jobId)
        if (cached) {
          title = title || cached.title
          salary = salary || cached.salary
        }
      }
      if (title || salary || info.brandName || info.hrName) {
        await updateMirrorChatIdentity(t.company, {
          hrName: info.hrName,
          company: info.brandName,
          jobTitle: title,
          salary,
        })
        filled++
      }
    }
    if (filled) {
      recentHRMessages.value = await renderableMirror()
      diag('CHAT', `后台无感回填岗位名 ${filled} 条（读取行组件 boss 对象）`)
    }
  } finally {
    backfillJobTitlesRunning = false
  }
}

/**
 * 删除指定会话（清理无效会话、降低列表噪声）。
 *
 * 仅在聊天页可用，删除后刷新 HR 消息列表。
 */
const deletingThread = ref<number | string | null>(null)

async function deleteHRThread(msg: HRMessageSummary, event: Event): Promise<void> {
  event.stopPropagation() // 防止触发卡片的 click 事件（打开会话）
  if (!onChatPage()) {
    openThreadMsg.value = '⚠ 删除会话仅在聊天页可用，请先跳转'
    return
  }

  // 会话托管期间禁止删除：托管正按索引遍历会话列表，删除会改变列表结构，
  // 让正在处理的那一条对不上号（resolveThread 会因此判定失败并跳过）。
  if (orchestratorRunning.value) {
    openThreadMsg.value = '⚠ 会话托管运行中，请先停止再删除会话'
    return
  }

  if (deletingThread.value) return
  deletingThread.value = msg.id

  try {
    // 身份（BOSS 原生 id / 后端岗位 id）随删除链路传递：定位与对账都精确到
    // 这一条，同公司多会话不会误删误标。
    const identity = { bossId: msg.bossId, encryptJobId: msg.encryptJobId }
    const r = await deleteThread(msg.company, msg.jobTitle, identity)
    if (r === 'ok') {
      openThreadMsg.value = `已删除「${msg.company}」的会话`
      // 页面已删：同步从本地镜像移除，避免非聊天页再渲染出这条死会话
      await removeMirrorByKey(msg.company, msg.jobTitle, identity)
      recentHRMessages.value = await renderableMirror()
    } else if (r === 'not-found') {
      openThreadMsg.value = `会话列表里没找到「${msg.company}」，可能需要先向下滚动加载`
    } else {
      openThreadMsg.value = `删除「${msg.company}」失败（BOSS 菜单未响应），请手动删除`
    }
  } finally {
    deletingThread.value = null
  }
}

/**
 * 聊天页挂载时消费跨页交接单：打开用户在别的页面点过的那个会话。
 *
 * 需要等会话列表渲染出来 —— 面板挂载时 BOSS 的列表往往还是空的，
 * 立刻 openThread 必然 not-found。这里轮询等待，最多 ~12s。
 */
async function consumePendingOpen(): Promise<void> {
  if (!onChatPage()) return
  const pending = await takePendingOpen()
  if (!pending) return
  diag('UI', '消费跨页交接单')
  for (let i = 0; i < 24; i++) {
    const r = openThread(pending.company, pending.jobTitle)
    if (r === 'ok') {
      openThreadMsg.value = `已打开「${pending.company}」的会话`
      return
    }
    if (r === 'failed') break
    await new Promise((res) => setTimeout(res, 500))
  }
  openThreadMsg.value = `未能自动打开「${pending.company}」，请在会话列表手动选择`
  diag('UI', '跨页打开会话失败')
}

/**
 * 跳到 BOSS 聊天页。
 *
 * 不在模板里直接写 location.href：Vue 模板作用域只认 setup 暴露的绑定，
 * 拿不到全局 location（编译期不报错、运行时才 undefined）。
 * 用平台适配器给的地址而非写死域名，将来接入别的平台不必改模板。
 */
function gotoChatPage(): void {
  if (platform?.chatUrl) window.location.href = platform.chatUrl
}

/** 相对时间文案（占位数据 timestamp=0 时不显示时间） */
function relativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

// ---- 编排器状态（智能投递 + 自动会话托管） ----
const orchestratorRunning = ref(false)
const orchestratorStats = reactive({
  appliedTotal: 0,
  hrRepliesTotal: 0,
  chatRoundsTotal: 0,
  phase: 'idle' as string,
  // 目标也镜像过来：进度条要用它当分母。只镜像 stats 的话，
  // 分母只能猜 config.maxApply，而编排器的目标来自个人中心配置，两者可能不同。
  goalType: '' as string,
  goalTarget: 0,
})

const progress = reactive<ApplyProgress>({
  scanned: 0, scanComplete: false, matched: 0, applied: 0, skipped: 0, failed: 0, unknown: 0,
  running: false, logs: [], currentJob: null,
})

/**
 * 进度条的分母：整轮投递目标数。
 *
 * 注意：投递策略已收归网页端，目标由编排器 state.goal 下发；
 * 这里是"正在跑的这轮，分母是多少"。已跑起来后真实目标在编排器
 * state.goal 里，以它为准。
 *
 * 取值分两种运行方式：
 * - 编排器在跑且目标是 apply_count → 用 state.goal.target（整轮、跨批次）。
 *   若改用 config.maxApply 会把单批上限当整轮，投到第 3 个就 100% 然后卡住。
 * - 只跑 ApplyEngine（没启编排器）→ config.maxApply 就是本次上限。
 *
 * hr_reply_count / time_elapsed 目标返回 0：那两种目标下"已投 N 个"没有对应
 * 分母，进度条不该显示（显示了就是编的）。
 */
const progressTarget = computed<number>(() => {
  if (orchestratorRunning.value) {
    return orchestratorStats.goalType === 'apply_count' ? orchestratorStats.goalTarget : 0
  }
  return config.maxApply || 0
})

/** 进度条分子：编排器在跑时用累计值（跨批次），否则用本次引擎进度 */
const progressApplied = computed<number>(() =>
  orchestratorRunning.value ? orchestratorStats.appliedTotal : progress.applied
)

/** 填充百分比。分母为 0 → null，模板据此整块不渲染 */
const applyProgressPct = computed<number | null>(() => {
  const target = progressTarget.value
  if (!target || target <= 0) return null
  // 夹到 0..100：投递数可能因重试等原因短暂超过目标
  return Math.min(100, Math.max(0, (progressApplied.value / target) * 100))
})

const ready = computed(() => isConfigReady(config))
const platformName = computed(() => platform?.name || '不支持的页面')
const loggedIn = computed(() => !!config.token)

async function doLogin() {
  if (!config.apiBase) {
    loginMsg.value = '请先填写后端地址'
    return
  }
  if (!loginEmail.value || !loginPassword.value) {
    loginMsg.value = '请填写邮箱和密码'
    return
  }
  loggingIn.value = true
  loginMsg.value = ''
  try {
    const res = await login(config.apiBase, loginEmail.value, loginPassword.value)
    config.token = res.token
    saveConfig(config)
    loginPassword.value = ''
    loginMsg.value = `已登录：${res.username}`
    // 登录成功后自动拉取简历列表
    await loadRemoteConfig()
  } catch (e) {
    loginMsg.value = (e as Error).message
  } finally {
    loggingIn.value = false
  }
}

function logout() {
  config.token = ''
  config.resumeId = null
  resumes.value = []
  loginMsg.value = ''
  saveConfig(config)
}

async function loadRemoteConfig(silent = false) {
  if (!config.apiBase || !config.token) {
    configError.value = '请先登录'
    return
  }
  if (!silent) loadingConfig.value = true
  configError.value = ''
  try {
    const data = await fetchPluginConfig(config)
    resumes.value = data.resumes
    // 简历 id → 名称缓存：会话里发简历时，BOSS 选择弹窗按名称匹配默认简历
    config.resumeNames = Object.fromEntries(data.resumes.map((r) => [String(r.id), r.name]))
    if (!config.resumeId && data.resumes.length > 0) {
      config.resumeId = data.resumes[0].id
    }
    // 默认发送简历：优先网页端设置（plugin_preferences 随后合并覆盖）；
    // 未设置时跟随投递用的简历，保证「投哪份就发哪份」的一致性
    if (!config.defaultSendResumeId && config.resumeId) {
      config.defaultSendResumeId = config.resumeId
    }
    if (config.threshold === 60) config.threshold = data.default_threshold
    // 同步网站侧的求职偏好（唯一真相源），避免插件与网站各配一套
    if (data.preferences) {
      const p = data.preferences
      if (typeof p.threshold === 'number') config.threshold = p.threshold
      if (typeof p.apply_limit === 'number') config.maxApply = p.apply_limit
      // 期望城市：用于会话里判断 HR 发来的工作地点卡片能否接受
      if (p.city) config.prefCity = p.city
      // 投递关键词：网页端偏好的 keyword 优先（可含多个，按空格/逗号拆）
      if (typeof p.keyword === 'string' && p.keyword.trim()) {
        applyKeywords.value = p.keyword.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean)
      }
      // 城市编码：仅接受 BOSS 数字编码，城市名不污染 ?city= 参数
      const cityRaw = (p as { city_code?: unknown }).city_code
      if (typeof cityRaw === 'string' && /^\d+$/.test(cityRaw.trim())) {
        applyCityCode.value = cityRaw.trim()
      }
      prefsSynced.value = true
    }
    // 关键词兜底：网页端没配 keyword 时，用简历提取的 top 技能
    if (!applyKeywords.value.length && Array.isArray(data.suggested_keywords)) {
      applyKeywords.value = data.suggested_keywords.filter(Boolean).slice(0, 5)
    }
    // 网页端插件偏好（回复模式等）覆盖本地设置：网页端为唯一真相源
    if (data.plugin_preferences) {
      Object.assign(config, applyPluginPreferences(config, data.plugin_preferences))
      saveConfig(config)
    }
    saveConfig(config)
  } catch (e) {
    const msg = (e as Error).message
    configError.value = msg
    // Token 过期/无效：主动清空并退回登录界面。
    // 否则 loggedIn 仅判 !!token 会一直显示「已登录」，
    // 用户既看不到登录框也没法换 token，陷入死结。
    if (msg.includes('(401)')) {
      config.token = ''
      config.resumeId = null
      resumes.value = []
      saveConfig(config)
      configError.value = '登录已过期，请重新登录'
    }
  } finally {
    loadingConfig.value = false
  }
}

function persist() {
  saveConfig(config)
}

/** 手工改后端地址：规范化（去尾斜杠）、存盘，并提示重新登录。 */
function onApiBaseChange() {
  config.apiBase = (config.apiBase || '').trim().replace(/\/+$/, '')
  // 切环境后旧 token 不再对应新后端，清掉强制重新登录，避免拿旧 token 打新后端报错。
  if (config.token) {
    config.token = ''
    loginMsg.value = '后端地址已更改，请重新登录'
  }
  saveConfig(config)
}

/** 手动粘贴 Token 后立即存盘并试拉配置（验证 Token 是否可用） */
async function onTokenPaste() {
  config.token = (config.token || '').trim()
  saveConfig(config)
  if (config.token) await loadRemoteConfig()
}

async function stopOrchestrator() {
  const orch = getOrchestrator(config)
  await orch.stop('用户手动停止')
  orchestratorRunning.value = false
  diag('APP', '编排器已停止')
}

/**
 * 插件内一键开始自动投递（闭环入口）。
 *
 * 直接启动编排器：若当前不在 BOSS 职位列表页，编排器会自己导航过去再跑，
 * 因此主页/聊天页都能点。关键词取自网页端求职偏好或简历技能，无需用户手填。
 * 投递额度等策略仍以网页端配置为准（start 内部读 config.maxApply 等）。
 */
async function startApply(): Promise<void> {
  startMsg.value = ''
  if (!ready.value) {
    startMsg.value = '请先登录并选择简历'
    return
  }
  if (!applyKeywords.value.length) {
    startMsg.value = '没有可用关键词，请在网页端「个人设置」填写期望职位，或上传简历后点「同步」'
    return
  }
  if (orchestratorRunning.value) {
    startMsg.value = '已在投递中'
    return
  }
  try {
    const orch = getOrchestrator(config)
    await orch.start(
      { type: 'apply_count', target: config.maxApply || 20 },
      applyKeywords.value,
      applyCityCode.value || undefined,
      undefined,
      'legacy',
      false,
      {
        chatInterval: config.chatCheckInterval,
        applyIntervalSeconds: config.applyIntervalSeconds,
        maxReplies: config.maxRepliesPerRound,
        maxPagesPerKeyword: config.maxPagesPerKeyword,
        minReplyScore: config.minReplyScore,
        replyScope: config.replyScope,
      },
    )
    orchestratorRunning.value = true
    diag('APP', `已启动自动投递：关键词=${applyKeywords.value.join('/')} 目标=${config.maxApply}`)
  } catch (e) {
    startMsg.value = `启动失败：${(e as Error).message}`
    diag('APP', `启动自动投递失败：${(e as Error).message}`)
  }
}

/** 状态轮询 timer（onUnmounted 需清掉，否则组件销毁后仍在跑） */
let statsTimer: number | undefined
/** 配置周期刷新 timer（网页端改偏好后 60s 内兜底同步） */
let configTimer: number | undefined

/** 网页端入队 config.reload 后的事件回调：静默重拉配置（核心配置实时生效） */
function onRemoteConfigReload() {
  void loadRemoteConfig(true)
}

// 定期更新编排器状态（从编排器实例读取最新统计）
function updateOrchestratorStats() {
  const orch = getOrchestrator(config)
  const state = orch.getState()
  if (state) {
    Object.assign(orchestratorStats, state.stats)
    orchestratorStats.phase = state.phase
    orchestratorStats.goalType = state.goal?.type || ''
    orchestratorStats.goalTarget = state.goal?.target || 0
    orchestratorRunning.value = orch.isRunning()
  }
}

onMounted(() => {
  // 注入确认 + 平台识别结果，便于「面板没出现/平台判错」类问题定位
  diag('INIT', `插件已注入 ${VERSION_LABEL}：平台=${platform?.name || '不支持'} url=${location.host}${location.pathname}`)
  if (config.apiBase && config.token) loadRemoteConfig()

  // 编排器内部自建 ApplyEngine，进度要回灌到面板，否则顶部五格恒为 0
  getOrchestrator(config).setApplyProgressHandler((p) => Object.assign(progress, p))

  // 尝试恢复编排器（页面刷新后自动续跑）
  resumeOrchestrator(config).then(() => {
    // 恢复成功后更新 UI 状态（从存储读取）
    updateOrchestratorStats()
  })

  // 每秒更新一次编排器状态 + 路由态（用于实时显示统计数据、SPA 换页后纠正分支）
  statsTimer = window.setInterval(() => {
    updateOrchestratorStats()
    syncRouteState()
  }, 1000)

  // HR 消息：立刻拉一次（本地镜像先渲染，再增量刷服务器），之后每 60s 一次；
  // 只在会话 Tab 可见时刷新，配合 since 增量参数，未变化时几乎零开销。
  // 定时器无条件建立、在回调里判断是否已配置 —— 若改成「已配置才建」，
  // 用户在设置页填完 Token 后本次会话就再也不会自动刷新了。
  loadHRMessages()
  hrTimer = window.setInterval(() => {
    if (!ready.value) return
    // 收起时不拉：面板收起时没人看这些卡片，请求纯属白打
    if (collapsed.value) return
    // 20s 节流：刚刷过就不重复拉
    if (Date.now() - lastChatRefreshAt < 20_000) return
    // 非聊天页降频：投递页不看会话卡片，3 分钟一次够了
    if (!isChatPage.value && Date.now() - lastHRFetchAt < HR_IDLE_INTERVAL_MS) return
    lastChatRefreshAt = Date.now()
    loadHRMessages()
  }, HR_REFRESH_MS)

  // 网页端「保存设置」会入队 config.reload 命令,这里监听事件即时重拉;
  // 60s 周期刷新兜底,确保网页端改的偏好最终一定生效。
  window.addEventListener('aah:config-reload', onRemoteConfigReload)
  window.addEventListener('aah:chat-mirror-changed', onMirrorChanged)
  configTimer = window.setInterval(() => {
    if (!ready.value) return
    if (collapsed.value) return
    void loadRemoteConfig(true)
  }, 60000)

  // 跨页交接：若用户在别的页面点了 HR 卡片，这里接手打开对应会话
  consumePendingOpen()

  // 职位列表页：只读探测筛选区结构（城市/求职类型/薪资/经验…），结果进日志，
  // 用于把「筛选条件」做成 agent 可控的工具；不点击任何控件。
  if (/\/web\/geek\/jobs?\b/.test(location.pathname)) {
    window.setTimeout(() => probeSearchFiltersOnce('page_load'), 3000)
  }

  // 聊天页：延迟后台静默回填岗位名（列表项无岗位名，需短暂打开会话读头部）
  if (onChatPage()) {
    window.setTimeout(() => void backfillChatJobTitles(), 4000)
  }
})
</script>

<template>
  <div class="aah-root" :style="{ top: ballPosition.top + 'px', right: ballPosition.right + 'px' }">
    <!-- 折叠态：悬浮球（可拖拽） -->
    <div
      v-if="collapsed"
      class="aah-ball"
      :class="{ dragging }"
      @mousedown="onDragStart"
      @click.stop="collapsed = false; ready && loadHRMessages()"
      @dblclick="resetBallPosition"
      title="智能投递助手（拖动调位置，双击重置）"
    >
      <span>投</span>
    </div>

    <!-- 展开态：Tab 抽屉。slide 过渡见 .aah-slide-* 规则。
         注意用的是 v-if="!collapsed" 而非 v-else —— 外面套了 <Transition>，
         v-else 与悬浮球的 v-if 不再是相邻兄弟，会编译报错。 -->
    <Transition name="aah-slide">
    <div v-if="!collapsed" class="aah-drawer">
      <!-- 标题栏即拖拽把手（按钮区已在 onDragStart 里排除） -->
      <div
        class="aah-header"
        :class="{ dragging }"
        @mousedown="onDragStart"
        @dblclick="resetBallPosition"
        title="拖动标题栏移动面板，双击复位"
      >
        <span class="aah-title">智能投递 · {{ platformName }} <small style="opacity:0.6;font-size:11px">{{ VERSION_LABEL }}</small></span>
        <div class="aah-header-btns">
          <!-- 🧪 测试工具：在面板内直接展开，避免独立窗口割裂 -->
          <button
            v-if="platform"
            class="aah-icon-btn"
            :class="{ active: showTests }"
            title="测试工具"
            @click="showTests = !showTests; showSettings = false"
          >🧪</button>
          <!-- ⚙ 快捷入口：展开底部「连接与设置」折叠区 -->
          <button
            v-if="platform"
            class="aah-icon-btn"
            :class="{ active: showSettings }"
            @click="gotoSettings"
            title="连接与设置"
          >⚙</button>
          <button class="aah-icon-btn" @click="collapsed = true" title="收起">─</button>
        </div>
      </div>

      <!-- 平台未识别（factory 返回 null）—— 理论上不会出现（@match 已限定域名） -->
      <div v-if="!platform" class="aah-body">
        <p class="aah-tip">当前页面不支持。请在 BOSS 直聘的任意页面使用。</p>
      </div>

      <!-- 单流引导式面板：一屏呈现「登录 → 选简历 → 开始投递」，主页也能用。
           会话列表常驻下方；连接与设置折叠在最底部。 -->
      <div v-else class="aah-flow">

        <TestTools v-if="showTests" @close="showTests = false" />
        <template v-else>

        <!-- 步骤 1：未登录 → 登录卡片（最显眼，先引导登录） -->
        <div v-if="!loggedIn" class="aah-step-card">
          <div class="aah-step-title">① 登录账号</div>
          <label class="aah-field aah-field-wide">
            <span>邮箱</span>
            <input v-model="loginEmail" placeholder="登录后端的邮箱" autocomplete="username" />
          </label>
          <label class="aah-field aah-field-wide">
            <span>密码</span>
            <input v-model="loginPassword" type="password" placeholder="密码"
              autocomplete="current-password" @keyup.enter="doLogin" />
          </label>
          <button class="aah-btn-primary" :disabled="loggingIn" @click="doLogin">
            {{ loggingIn ? '登录中...' : '登录' }}
          </button>
          <p v-if="loginMsg" class="aah-error">{{ loginMsg }}</p>
          <details class="aah-advanced">
            <summary>登录不了？粘贴网页端 Token</summary>
            <label class="aah-field aah-field-wide">
              <span>Token（网页端 localStorage.token）</span>
              <input v-model="config.token" placeholder="eyJhbGciOi..." @change="onTokenPaste" />
            </label>
          </details>
        </div>

        <!-- 已登录：引导流 + 会话列表 -->
        <template v-else>
          <!-- 步骤 2：选简历（未选简历时高亮引导） -->
          <div class="aah-step-card" :class="{ 'aah-step-todo': !config.resumeId }">
            <div class="aah-step-row">
              <span class="aah-step-title">② 投递简历</span>
              <button class="aah-link-btn" :disabled="loadingConfig" @click="loadRemoteConfig()">
                {{ loadingConfig ? '同步中...' : '↻ 同步' }}
              </button>
            </div>
            <label class="aah-field aah-field-wide" v-if="resumes.length">
              <select v-model="config.resumeId" @change="persist">
                <option v-for="r in resumes" :key="r.id" :value="r.id">
                  {{ r.name }}（{{ r.skills_count }} 技能）
                </option>
              </select>
            </label>
            <p v-if="resumes.length === 0 && !loadingConfig" class="aah-tip">
              暂无简历，请先在网页端上传简历，再点上方「↻ 同步」。
            </p>
          </div>

          <!-- 步骤 3：开始投递（闭环入口；编排器自动跳列表页并跨页运行） -->
          <div class="aah-step-card">
            <div class="aah-step-title">③ 自动投递</div>

            <!-- 运行中：显示实时状态 + 停止 -->
            <div v-if="orchestratorRunning" class="aah-orchestrator-status">
              <div class="aah-phase-badge" :class="'phase-' + orchestratorStats.phase">
                {{ orchestratorStats.phase === 'chat' ? '🤖 会话托管中' : orchestratorStats.phase === 'apply' ? '🎯 投递中' : '运行中' }}
              </div>
              <div
                v-if="applyProgressPct !== null"
                class="aah-job-progress-text"
                style="margin:6px 0"
              >整轮进度 {{ progressApplied }}/{{ progressTarget }}</div>
              <div class="aah-stats">
                <div class="aah-stat aah-ok"><b>{{ orchestratorStats.appliedTotal }}</b><span>已投</span></div>
                <div class="aah-stat"><b>{{ orchestratorStats.hrRepliesTotal }}</b><span>HR回复</span></div>
                <div class="aah-stat"><b>{{ orchestratorStats.chatRoundsTotal }}</b><span>会话轮</span></div>
              </div>
              <p v-if="navUnread > 0" class="aah-nav-unread" style="margin:4px 0">
                🔴 导航未读 {{ navUnread }} 条
              </p>
              <button class="aah-btn-danger" @click="stopOrchestrator">停止投递</button>
            </div>

            <!-- 未运行：一键开始 -->
            <template v-else>
              <button class="aah-btn-primary aah-btn-start" :disabled="!ready" @click="startApply">
                ▶ 开始自动投递
              </button>
              <p v-if="!ready" class="aah-tip">请先完成上面的登录与选简历。</p>
              <p v-else-if="applyKeywords.length" class="aah-tip">
                投递关键词：{{ applyKeywords.join(' / ') }}
                <span class="aah-hint">（来自网页端求职偏好 / 简历技能，可在网页端「个人设置」修改）</span>
              </p>
              <p v-else class="aah-tip">
                暂无关键词。请在网页端「个人设置」填写期望职位，或上传简历后点「↻ 同步」。
              </p>
              <p v-if="startMsg" class="aah-error">{{ startMsg }}</p>
              <p class="aah-hint">
                点击后自动打开职位列表并持续投递，期间自动托管 HR 会话（回复/发简历/答薪资面试），
                刷新页面也会自动恢复。
              </p>
            </template>
          </div>

          <!-- 会话列表（HR 最近消息；常驻，便于随时查看与手动介入） -->
          <div class="aah-hr-conversations">
            <div class="aah-diag-head">
              <span>
                会话（{{ recentHRMessages.length }}）
                <span v-if="navUnread > 0" class="aah-nav-unread" title="BOSS 导航「消息」未读数">
                  🔴 {{ navUnread }} 条未读
                </span>
              </span>
              <span class="aah-head-right">
                <span v-if="hrMessagesLoading">加载中...</span>
                <button
                  v-if="!isChatPage && platform?.chatUrl"
                  class="aah-link-btn"
                  @click="gotoChatPage"
                >去聊天页</button>
              </span>
            </div>

            <p v-if="hrMessagesError" class="aah-error">{{ hrMessagesError }}</p>

            <!-- 点击卡片 → 打开对应会话（跨页时先落盘再跳转） -->
            <div
              v-for="msg in recentHRMessages"
              :key="msg.id"
              class="aah-hr-message"
              :class="{ unread: msg.unread, 'low-score': !!skipInfo(msg) }"
              role="button"
              tabindex="0"
              :title="`打开与「${msg.company}」的会话`"
              @click="openHRThread(msg)"
              @keydown.enter="openHRThread(msg)"
              @keydown.space.prevent="openHRThread(msg)"
            >
              <div class="aah-hr-header">
                <span class="aah-hr-company">
                  <span v-if="msg.hrName" class="aah-hr-name">{{ msg.hrName }}</span>{{ msg.company }}
                </span>
                <div class="aah-hr-actions">
                  <span
                    v-if="skipInfo(msg)"
                    class="aah-skip-badge"
                    :title="skipInfo(msg)!.title"
                  >⊘ {{ skipInfo(msg)!.label }}</span>
                  <span class="aah-hr-time">{{ relativeTime(msg.timestamp) }}</span>
                  <button
                    v-if="isChatPage"
                    class="aah-delete-btn"
                    :disabled="deletingThread !== null || orchestratorRunning"
                    :title="orchestratorRunning ? '投递运行中，无法删除' : '删除此会话（不可恢复）'"
                    @click="deleteHRThread(msg, $event)"
                  >{{ deletingThread === msg.id ? '⏳' : '🗑️' }}</button>
                </div>
              </div>
              <div class="aah-hr-meta">
                <span v-if="msg.jobTitle" class="aah-hr-job">{{ msg.jobTitle }}</span>
                <span v-else class="aah-hr-job aah-hr-job-empty">岗位未知</span>
                <span v-if="msg.salary" class="aah-hr-salary">{{ msg.salary }}</span>
              </div>
              <div class="aah-hr-content">{{ msg.content }}</div>
            </div>

            <p v-if="openThreadMsg" class="aah-hint">{{ openThreadMsg }}</p>
            <p
              v-if="!recentHRMessages.length && hrMessagesLoaded && !hrMessagesError"
              class="aah-hint"
            >暂无 HR 消息</p>
          </div>
        </template>

        <!-- 连接与设置（折叠；⚙ 或下方标题展开） -->
        <div class="aah-settings-section">
          <button class="aah-settings-toggle" @click="showSettings = !showSettings">
            {{ showSettings ? '▾' : '▸' }} 连接与设置
          </button>
          <div v-if="showSettings" class="aah-settings-body aah-form-grid">
            <div class="aah-field aah-field-wide">
              <span>连接环境</span>
              <span class="aah-env-badge" :class="{ local: apiEnvironmentLabel === '本地联调' }">
                {{ apiEnvironmentLabel }}
              </span>
              <input
                v-model.trim="config.apiBase"
                class="aah-field-wide"
                placeholder="后端地址，如 http://127.0.0.1:8010"
                autocomplete="off"
                spellcheck="false"
                @change="onApiBaseChange"
              />
              <p class="aah-tip">改地址后需重新登录。本地联调填 http://127.0.0.1:8010</p>
            </div>
            <div v-if="loggedIn" class="aah-loggedin">
              <span class="aah-ok-text">✓ 已登录</span>
              <button class="aah-link-btn" @click="logout">退出登录</button>
            </div>
            <p v-if="prefsSynced" class="aah-tip">
              已同步网页端「个人设置」的求职偏好；改配置请在网页端修改后点上方「↻ 同步」。
            </p>
            <label class="aah-field aah-field-wide">
              <span>投递筛选</span>
              <label class="aah-row" style="gap:6px">
                <input type="checkbox" v-model="config.matchEnabled" @change="persist" />
                启用匹配度计算（按阈值筛选）
              </label>
              <span class="aah-hint">
                关闭后跳过后端匹配接口，扫描到的岗位全部投递（黑名单/最低薪资规则仍生效）
              </span>
            </label>
            <label class="aah-field aah-field-wide">
              <span>岗位 JD</span>
              <label class="aah-row" style="gap:6px">
                <input type="checkbox" v-model="config.scanWithDetail" @change="persist" />
                扫描时逐个打开详情，读取 JD 全文用于匹配
              </label>
              <span class="aah-hint">
                列表页只有标签摘要。打开后每个岗位多一次详情加载（约 0.5 秒），匹配更准但扫描变慢。
              </span>
            </label>
            <p class="aah-tip">
              投递额度、投递间隔、投递节奏、回复预算、翻页上限、最低回复分、会话清理等策略
              已收归网页端「我的助手」管理，插件只负责执行。
            </p>
            <p v-if="configError" class="aah-error">{{ configError }}</p>
          </div>
        </div>
        </template>

      </div>
    </div>
    </Transition>
  </div>
</template>

<style>
.aah-root { position: fixed; z-index: 999999; font-size: 13px; font-family: -apple-system, sans-serif; transition: top 0.1s, right 0.1s; }
.aah-ball { width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg,#3b82f6,#2563eb); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:bold; cursor:move; box-shadow:0 4px 12px rgba(0,0,0,.2); user-select: none; }
.aah-ball.dragging { cursor: grabbing; box-shadow:0 8px 24px rgba(0,0,0,.3); }
.aah-drawer { width: 560px; background:#fff; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.18); overflow:hidden; border:1px solid #e5e7eb; }

/* ---- 单流引导式布局 ---- */
.aah-flow { max-height:72vh; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:12px; }
.aah-step-card { background:#f9fafb; border:1px solid #e5e7eb; border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:10px; }
.aah-step-card.aah-step-todo { border-color:#f59e0b; background:#fffbeb; }
.aah-step-title { font-size:14px; font-weight:600; color:#111827; }
.aah-step-row { display:flex; align-items:center; justify-content:space-between; }
.aah-btn-start { font-size:15px; padding:12px; font-weight:600; }
.aah-settings-section { border-top:1px solid #e5e7eb; padding-top:8px; }
.aah-settings-toggle { background:none; border:none; color:#6b7280; font-size:13px; cursor:pointer; padding:4px 0; }
.aah-settings-toggle:hover { color:#374151; }
.aah-settings-body { margin-top:8px; }
.aah-nav-unread { color:#dc2626; font-size:12px; font-weight:600; }

.aah-icon-btn.active { background:rgba(255,255,255,.5); box-shadow:inset 0 0 0 1px #fff; }

/* ---- Tab 布局：左导航 80px + 右内容 480px ---- */
/* min-height:0 是必需的：flex 子项默认 min-height:auto，内容超高时不会收缩，
   导致 .aah-tab-content 的 overflow-y 失效、整个抽屉被撑破 70vh 限制。 */
.aah-tabs-container { display:flex; height:70vh; max-height:800px; min-height:0; }
.aah-tab-nav { width:80px; flex:0 0 80px; background:#f9fafb; border-right:1px solid #e5e7eb; display:flex; flex-direction:column; }
.aah-tab { padding:16px 12px; text-align:center; font-size:12px; color:#6b7280; cursor:pointer; border-left:3px solid transparent; transition:background .15s, color .15s, border-color .15s; user-select:none; }
.aah-tab:hover { background:#f3f4f6; color:#374151; }
.aah-tab.active { background:#fff; color:#2563eb; border-left-color:#2563eb; font-weight:600; }
.aah-tab-content { flex:1; min-width:0; overflow-y:auto; }
.aah-tab-pane { padding:16px; line-height:1.6; }
/* 铺满型 Tab（会话页）：整页纵向占满，内部由 flex:1 的子元素吃掉剩余高度。
   box-sizing 必不可少 —— 否则 16px padding 叠在 100% 之上会溢出、
   把外层 .aah-tab-content 的滚动条撑出来。
   min-height:0 是 flex 子项能收缩的前提，缺了它内部滚动区不会生效。 */
.aah-pane-fill { display:flex; flex-direction:column; height:100%; min-height:0; box-sizing:border-box; }
/* 铺满模式下，列表容器接管剩余空间并自己滚动 */
.aah-pane-fill .aah-hr-conversations { flex:1; min-height:0; max-height:none; }
/* 列表以外的元素（按钮/提示/分隔线）保持自然高度。
   flex 子项默认 flex-shrink:1，不锁住的话它们会被压缩变形。 */
.aah-pane-fill > *:not(.aah-hr-conversations) { flex:0 0 auto; }
/* 「会话列表（N）」表头在滚动时吸顶，长列表里才知道自己在看什么 */
.aah-pane-fill .aah-hr-conversations .aah-diag-head {
  position:sticky; top:0; background:#fff; z-index:1; padding-bottom:4px;
}
.aah-head-right { display:inline-flex; align-items:center; gap:8px; }

/* ===== 过渡 ===== */

/* Tab 切换：150ms 淡入淡出（mode=out-in，故总时长约 300ms）。
   只动 opacity，不动 transform —— 内容区可滚动，位移会连带滚动条抖动。 */
.aah-fade-enter-active, .aah-fade-leave-active { transition:opacity .15s ease; }
.aah-fade-enter-from, .aah-fade-leave-to { opacity:0; }

/* 抽屉展开/收起：右上角为原点的 slide + fade。
   收起比展开快（.18s vs .22s）：关闭时用户已决定离开，慢动画显得拖沓。 */
.aah-slide-enter-active { transition:opacity .22s ease, transform .22s cubic-bezier(.16,1,.3,1); }
.aah-slide-leave-active { transition:opacity .18s ease, transform .18s ease-in; }
.aah-slide-enter-from, .aah-slide-leave-to { opacity:0; transform:translateX(16px) scale(.97); }
/* 变换原点设在右上：抽屉贴着右上角的悬浮球，从那个角"长出来"才符合来处 */
.aah-drawer { transform-origin:100% 0; }

/* 尊重系统减少动画偏好：前庭功能敏感的用户会因位移动画不适。
   这里整体关掉过渡而非缩短时长 —— 半速的位移仍是位移。 */
@media (prefers-reduced-motion: reduce) {
  .aah-fade-enter-active, .aah-fade-leave-active,
  .aah-slide-enter-active, .aah-slide-leave-active,
  .aah-job-progress-fill { transition:none; }
  .aah-slide-enter-from, .aah-slide-leave-to { transform:none; }
}
.aah-config-notice { padding:12px; background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; color:#92400e; font-size:12px; line-height:1.6; }

/* ---- 会话 Tab ---- */
.aah-hr-conversations { display:flex; flex-direction:column; gap:12px; max-height:320px; overflow-y:auto; }
/* 卡片可点击（打开对应会话）：给 pointer + hover/focus 反馈，
   否则用户看不出这块能点。focus-visible 保证键盘操作也有可见焦点。 */
.aah-hr-message { padding:12px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; cursor:pointer; transition:background .12s, border-color .12s; }
.aah-hr-message:hover { background:#f3f4f6; border-color:#d1d5db; }
.aah-hr-message:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
/* 未读用左侧蓝条标记，比整块变色克制，不至于让列表花掉 */
.aah-hr-message.unread { border-left:3px solid #2563eb; background:#f0f9ff; }
.aah-hr-message.unread:hover { background:#e0f2fe; }
/* 低分/无分（会被自动回复跳过）：左侧灰条 + 整体压暗，一眼能与正常会话分开。
   不用红色：这不是错误，是按用户设定的阈值做出的正常筛选，红色会造成误解。
   放在 .unread 之后，故低分未读会话显示为低分态 —— 这符合优先级：
   「它不会被自动回复」比「它未读」更需要用户注意。 */
.aah-hr-message.low-score { border-left:3px solid #9ca3af; background:#f3f4f6; opacity:.72; }
.aah-hr-message.low-score:hover { background:#e5e7eb; opacity:1; }
/* 跳过原因徽标：紧凑、可 hover 出完整解释（title） */
.aah-skip-badge { flex-shrink:0; padding:1px 6px; background:#e5e7eb; color:#4b5563; border-radius:4px; font-size:10px; white-space:nowrap; cursor:help; }
.aah-hr-header { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:4px; }
.aah-hr-actions { display:flex; align-items:center; gap:8px; }
.aah-delete-btn { background:none; border:none; padding:2px 4px; cursor:pointer; font-size:14px; opacity:0.6; transition:opacity .15s, transform .15s; }
.aah-delete-btn:hover { opacity:1; transform:scale(1.15); }
.aah-delete-btn:active { transform:scale(0.95); }
.aah-delete-btn:disabled { opacity:0.25; cursor:not-allowed; transform:none; }
.aah-hr-company { font-size:13px; font-weight:600; color:#111827; word-break:break-all; }
.aah-hr-name { color:#7c3aed; font-weight:700; margin-right:4px; }  /* HR 姓名紫色，与公司/岗位区分 */
.aah-hr-message.unread .aah-hr-company { color:#1d4ed8; }
.aah-hr-time { font-size:11px; color:#9ca3af; white-space:nowrap; flex:0 0 auto; }
/* 岗位名：彩色标签与公司/正文区分 */
.aah-hr-job { display:inline-block; margin:2px 0 6px; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:600; color:#0e7490; background:#ecfeff; border:1px solid #a5f3fc; word-break:break-all; }
.aah-hr-job-empty { color:#9ca3af; background:#f3f4f6; border-color:#e5e7eb; }
.aah-hr-salary { display:inline-block; margin:2px 0 6px 4px; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:600; color:#047857; background:#ecfdf5; border:1px solid #a7f3d0; }
.aah-hr-content { font-size:12px; color:#6b7280; line-height:1.6; word-break:break-all; }

/* cursor:move 是「这里能拖」的唯一可见提示，缺了用户不会去试 */
.aah-header { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#2563eb; color:#fff; cursor:move; user-select:none; }
.aah-header.dragging { cursor:grabbing; }
/* 按钮区恢复默认指针：那里点击不拖拽 */
.aah-header-btns button { cursor:pointer; }
.aah-title { font-weight:600; font-size:13px; }
.aah-header-btns { display:flex; gap:4px; }
.aah-icon-btn { background:rgba(255,255,255,.2); border:none; color:#fff; width:24px; height:24px; border-radius:6px; cursor:pointer; }
.aah-icon-btn:hover { background:rgba(255,255,255,.35); }
/* 已在设置 Tab 时高亮，避免用户反复点同一个按钮找不到反馈 */
.aah-icon-btn.active { background:#fff; color:#2563eb; }
.aah-body { padding:16px; max-height:60vh; overflow-y:auto; line-height:1.6; }
.aah-tip { color:#6b7280; font-size:12px; line-height:1.6; }
/* 字段间距统一 12px（原 10px），与 section 的 16px 形成层级 */
/* 设置 Tab 两列栅格。column-gap 略大于 row-gap，让"同一行的两个字段"
   与"上下两行"在视觉上可区分。 */
.aah-form-grid { display:grid; grid-template-columns:1fr 1fr; column-gap:14px; align-items:start; }
/* 栅格里 .aah-field 的 margin-bottom 交给 grid row-gap 统一管，避免双份间距 */
.aah-form-grid > .aah-field { margin-bottom:12px; }
/* 跨整行：复合字段、长文本字段、勾选项 */
.aah-form-grid > .aah-field-wide { grid-column:1 / -1; }
/* 非 field 的块级元素（按钮、提示、错误、已登录条）一律整行 —— 半列按钮既难点
   又会与相邻字段错位 */
.aah-form-grid > button,
.aah-form-grid > p,
.aah-form-grid > .aah-loggedin { grid-column:1 / -1; }
.aah-field { display:flex; flex-direction:column; gap:4px; margin-bottom:12px; }
.aah-field > span { font-size:12px; color:#374151; }
.aah-field input, .aah-field select { padding:6px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; }
.aah-env-badge { align-self:flex-start; display:inline-flex; align-items:center; padding:2px 7px; border-radius:999px; font-size:11px; font-weight:600; color:#92400e; background:#fffbeb; border:1px solid #fde68a; }
.aah-env-badge.local { color:#065f46; background:#ecfdf5; border-color:#a7f3d0; }
.aah-row { display:flex; align-items:center; gap:6px; }
.aah-btn-primary { width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:8px; font-weight:600; cursor:pointer; }
.aah-btn-primary:hover { background:#1d4ed8; }
.aah-btn-danger { width:100%; padding:10px; background:#dc2626; color:#fff; border:none; border-radius:8px; font-weight:600; cursor:pointer; }
.aah-btn-secondary { width:100%; padding:8px; background:#f3f4f6; color:#374151; border:1px solid #d1d5db; border-radius:6px; cursor:pointer; margin-bottom:12px; }
.aah-loggedin { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
.aah-ok-text { color:#16a34a; font-size:13px; font-weight:600; }
.aah-link-btn { background:none; border:none; color:#6b7280; font-size:12px; cursor:pointer; text-decoration:underline; }
.aah-link-btn:hover { color:#dc2626; }
.aah-stats { display:flex; justify-content:space-between; margin-bottom:12px; }
.aah-stat { display:flex; flex-direction:column; align-items:center; flex:1; }
.aah-stat b { font-size:18px; color:#111827; }
.aah-stat span { font-size:11px; color:#9ca3af; }
.aah-stat.aah-ok b { color:#16a34a; }
.aah-stat.aah-skip b { color:#9ca3af; }
.aah-stat.aah-fail b { color:#f59e0b; }
.aah-logs { margin-top:12px; max-height:180px; overflow-y:auto; background:#f9fafb; border-radius:6px; padding:8px; }
.aah-diag-head { display:flex; justify-content:space-between; align-items:center; margin-top:12px; font-size:11px; color:#6b7280; }
.aah-diag { max-height:150px; background:#111827; }
.aah-diag .aah-log-line { color:#9ca3af; font-size:10px; }
.aah-dom-view .aah-log-line { color:#a5b4fc; }  /* DOM 采集区用淡紫色与行为记录区分 */
.aah-log-line { font-size:11px; color:#4b5563; line-height:1.6; font-family:monospace; word-break:break-all; }
.aah-error { color:#dc2626; font-size:12px; margin-top:6px; }

/* 编排器样式 */
.aah-orchestrator-section { margin-bottom:16px; padding:12px; background:#f0f9ff; border-radius:8px; border:1px solid #bae6fd; }
.aah-section-title { font-size:13px; font-weight:600; margin:0 0 8px 0; color:#1e40af; }
.aah-orchestrator-status { display:flex; flex-direction:column; gap:10px; }
.aah-orchestrator-running-notice { margin-bottom:12px; padding:12px; background:#fef3c7; border-radius:8px; border:1px solid #fbbf24; }
.aah-phase-badge { display:inline-block; padding:4px 10px; border-radius:6px; font-size:11px; font-weight:600; background:#dbeafe; color:#1e40af; }
.aah-phase-badge.phase-chat { background:#d1fae5; color:#065f46; }
.aah-phase-badge.phase-apply { background:#fef3c7; color:#92400e; }
.aah-orchestrator-config { display:flex; flex-direction:column; gap:8px; }
.aah-unit { font-size:11px; color:#6b7280; margin-left:6px; white-space:nowrap; }
.aah-hint { font-size:11px; color:#9ca3af; line-height:1.6; }
.aah-filter-box { padding-top:4px; }
.aah-filter-chip { display:inline-block; margin:2px 4px 2px 0; padding:2px 8px; border-radius:999px; font-size:11px; color:#1e40af; background:#dbeafe; border:1px solid #bfdbfe; cursor:pointer; user-select:none; }
.aah-filter-chip:hover { background:#bfdbfe; }
.aah-divider { height:1px; background:#e5e7eb; margin:16px 0; }
.aah-advanced > summary { font-size:12px; color:#6b7280; cursor:pointer; user-select:none; padding:4px 0; }
.aah-advanced > summary:hover { color:#374151; }
.aah-advanced[open] > summary { margin-bottom:6px; }

/* 当前投递岗位卡片 */
/* 卡片改成 flex 容器：左侧 4px 进度条 + 右侧原内容。
   align-items:stretch（flex 默认）让竖条自动等高于卡片内容，不必写死高度。 */
.aah-current-job { display:flex; gap:10px; margin:12px 0; padding:10px 12px; background:#f0f9ff; border-radius:8px; border:1px solid #bae6fd; }
.aah-current-job-body { flex:1 1 auto; min-width:0; }
/* 进度轨：4px 宽，flex:0 0 auto 防止被内容挤扁 */
.aah-job-progress { flex:0 0 auto; width:4px; border-radius:2px; background:#dbeafe; overflow:hidden;
  /* 自下而上填充：轨道内以列反向排布，填充块贴底 */
  display:flex; flex-direction:column; justify-content:flex-end; }
.aah-job-progress-fill { width:100%; background:#2563eb; border-radius:2px; transition:height .3s ease; }
.aah-current-job-title { font-size:11px; color:#1e40af; font-weight:600; margin-bottom:6px; display:flex; justify-content:space-between; align-items:baseline; gap:6px; }
/* 分数文字用等宽数字，避免 9/10→10/10 时宽度跳动 */
.aah-job-progress-text { font-weight:500; color:#3b82f6; font-variant-numeric:tabular-nums; }
.aah-job-name { font-size:13px; font-weight:600; color:#0c4a6e; margin-bottom:4px; }
.aah-job-company { font-size:12px; color:#0369a1; margin-bottom:4px; }
.aah-job-score { font-size:11px; color:#0284c7; }

/* 质量拦截列表（岗位级，含原因） */
.aah-quality-blocked { margin:12px 0; padding:10px 12px; background:#fef2f2; border-radius:8px; border:1px solid #fecaca; }
.aah-quality-blocked-title { font-size:12px; font-weight:600; color:#b91c1c; margin-bottom:6px; display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
.aah-quality-blocked-item { font-size:11px; color:#7f1d1d; padding:3px 0; border-bottom:1px dashed #fecaca; }
.aah-quality-blocked-item:last-child { border-bottom:none; }
.aah-quality-blocked-reason { color:#9f1239; display:block; font-size:10px; margin-top:2px; }

/* 深度翻页测试（滚动采集） */
.aah-probe-section { margin:14px 0; padding:12px; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0; }
.aah-probe-results { margin-top:10px; }
.aah-probe-summary { font-size:12px; color:#334155; margin-bottom:6px; }
.aah-probe-table { width:100%; border-collapse:collapse; font-size:11px; }
.aah-probe-table th, .aah-probe-table td { border:1px solid #e2e8f0; padding:3px 6px; text-align:center; }
.aah-probe-table th { background:#f1f5f9; color:#475569; }
.aah-probe-signal { font-size:10px; color:#64748b; }
.aah-probe-dom { margin-top:10px; }
.aah-probe-dom-title { font-size:12px; font-weight:600; color:#334155; margin-bottom:4px; }
.aah-probe-dom-pre { margin:0; padding:8px 10px; background:#0f172a; color:#e2e8f0; border-radius:6px; font-size:11px; line-height:1.6; white-space:pre-wrap; word-break:break-all; }

</style>

// 插件共享类型定义

/** 平台代号 */
export type PlatformCode = 'zhipin' | 'zhaopin' | 'liepin' | 'qiancheng'

/** Agent 的单个动作策略。后端可按动作覆盖，插件只在 allow 时直接执行。 */
export type AgentActionMode = 'allow' | 'deny' | 'notify_after' | 'notify_before' | 'ask_once'

/** BOSS 联系方式卡片允许交换的渠道。 */
export type ContactChannel = 'phone' | 'wechat' | 'email' | 'other'

/** 来自 users.plugin_preferences 的联系方式策略（snake_case 与 camelCase 均由解析层兼容）。 */
export interface ContactPolicy {
  channels: ContactChannel[]
  allowPlatformCard: boolean
}

/** BOSS Agent 策略。LLM 不直接决定权限，插件只执行这里允许的动作。 */
export interface AgentPolicy {
  /** Backend uses `guided`; `assisted` remains for older clients/preferences. */
  mode: 'full_auto' | 'guided' | 'assisted' | 'manual'
  actions: Record<string, AgentActionMode>
  contact: ContactPolicy
}

/** 从页面扫描到的单个岗位卡片 */
export interface JobCard {
  platformJobId: string // 平台职位唯一 ID（去重用）
  title: string // 职位标题
  company: string // 公司名
  city?: string // 城市
  salary?: string // 薪资文本（如 "15-25K"）
  description?: string // 列表页能拿到的摘要（标签拼接），不是 JD 全文
  /** 岗位 JD 全文（打开详情面板读取；需开启 scanWithDetail，见 PluginConfig） */
  jd?: string
  url?: string // 职位详情 URL
  /** 卡片根元素（用于高亮/标记已处理） */
  cardElement?: HTMLElement
}

/** 后端匹配结果 */
export interface MatchResultItem {
  platform_job_id: string
  score: number
  recommend: boolean
  reason: string
  /** company_apply_limit=该公司近期投递已达上限 */
  blocked_reason?: string
}

/** 投递过滤规则（来自后端 /api/plugin/rules，与 Web Agent 同源） */
export interface ApplyRule {
  id: number
  rule_type: string // block_company | block_keyword | min_salary
  value: string
}

/** 投递真实结果：applied=平台已确认 / unknown=无法确认 / failed=明确失败 */
export type ApplyOutcome = 'applied' | 'unknown' | 'failed'

/** 插件配置（存 GM_setValue） */
export interface PluginConfig {
  apiBase: string // 后端地址，如 https://gudaya.chat
  token: string // JWT Token
  resumeId: number | null // 选用的简历 ID
  threshold: number // 匹配阈值（>= 则投递）
  /**
   * 是否启用匹配度计算。true=调后端 /api/plugin/match 按阈值筛选（默认）；
   * false=跳过匹配接口，规则过滤（黑名单/最低薪资）通过后全部投递。
   */
  matchEnabled: boolean
  maxApply: number // 单次最多投递数
  /**
   * 编排器：每投递多少个岗位后处理一次消息会话（批次大小，可配置）。
   * 控制「投递 ↔ 会话托管」的切换节奏；越大投递越连贯、会话检查越稀疏。
   */
  chatCheckInterval: number
  /** 编排器：每个关键词最多翻页数（翻完自动切换下一个关键词，防重复搜索） */
  maxPagesPerKeyword: number
  /**
   * 编排器搜索时复用的筛选参数（URL query 串，不含 query/page）。
   * 从 BOSS 搜索页「捕获当前页筛选」获得：用户选好职位类型/区域等后，
   * 插件记住这些参数并在每次翻页/换关键词时原样带上。
   */
  searchFilterQuery: string
  /**
   * 扫描岗位时是否逐个打开详情读 JD 全文。
   * 列表页只有标签摘要，JD 全文要读右侧详情面板；每个岗位多一次点击+等待，
   * 扫描会明显变慢，故默认关闭。
   */
  scanWithDetail?: boolean
  /**
   * 投递间隔（秒）：投完一个岗位 → 等待该间隔 → 投下一个。
   * 单一来源（内置 ±10% 随机抖动模拟真人），不再有「随机范围 + 地板」两套概念。
   */
  applyIntervalSeconds: number
  /** 自动翻页：当前页投完后自动进入下一页继续（直到达上限或无下一页） */
  autoPaginate: boolean
  /** 自动翻页最多翻几页（防跑飞） */
  maxPages: number
  /** 期望工作城市（从网站求职偏好同步）。用于判断 HR 发来的工作地点卡片是否接受 */
  prefCity: string
  /**
   * 城市不符时是否拒绝工作地点卡片。
   *
   * 默认 false（接受并标记）：机会不该因为地点自动放弃，用户可能愿意考虑。
   * 需要严格按城市筛选的用户，在设置页显式开启后才生效。
   */
  rejectOffCityLocation: boolean
  /**
   * 会话回复匹配分阈值。低于此值的会话不调 LLM，直接跳过。默认 50。
   * 用于过滤 HR 主动骚扰（垃圾岗位、审核员等）。
   */
  minReplyScore: number
  /**
   * 会话回复范围（2026-08-05 新增）：
   * - this_round：只回复「本轮投递岗位」收到的 HR 消息（默认）；
   * - all：回复全部待回复 HR 消息（仍按 minReplyScore 过滤）。
   * 网页端可覆盖此设置（users.plugin_preferences）。
   */
  replyScope: 'this_round' | 'all'
  /** 单轮最多回复条数（用户要求先 5-10 条测试发简历链路） */
  maxRepliesPerRound: number
  /**
   * 已读超时未回会话清理（2026-08-05 新增）：
   * HR 消息已被读（无未读标记）且超过 cleanReadAfterHours 小时未回复，
   * 判定该岗位流程已结束 → 删除会话。可在插件/网页端设置，可关闭。
   */
  cleanReadConversations: boolean
  cleanReadAfterHours: number
  /** 清理/跟进前的「用户正在操作」守卫窗口（秒）。默认 3：挂机时偶尔滚动/点击
   *  不至于整轮删除全部被挡；仍能在用户连续操作时保护会话。 */
  cleanupGuardSeconds?: number
  /** 默认发送的简历 ID（网页端可设置；null=用 BOSS 弹窗默认第一份） */
  defaultSendResumeId: number | null
  /** 简历 id → 名称（从 /api/plugin/config 同步，简历选择弹窗里按名字匹配） */
  resumeNames: Record<string, string>
  /** 是否启用 LLM 低质量岗位判定（外包/批量招聘等，默认开启） */
  qualityJudge: boolean
  /** 网页端同步的 Agent 策略；联系方式卡片由此策略决定是否自动同意。 */
  agentPolicy: AgentPolicy
}

/** 面板 Tab 键 */
export type TabKey = 'apply' | 'chat' | 'settings' | 'logs'

/**
 * 会话 Tab 展示用的 HR 消息摘要。
 *
 * 数据来源：GET /api/conversations/list 的 last_hr_message 字段（一次请求拿全）。
 * 不逐条拉 /api/conversations/{id}：那个端点会对未回复消息调 LLM 生成回复草稿，
 * 轮询会带来大量 LLM 调用。
 */
export interface HRMessageSummary {
  /** 我方后端的 conversation.id（非 BOSS 会话 ID，不能用于 URL 跳转） */
  id: number
  /** HR 姓名（BOSS 列表 DOM 提供；后端记录没有此字段，缺失时回退只显示公司） */
  hrName?: string
  /** 岗位薪资（如 "8-12K"；来源：会话头部/行组件数据，DOM 是字体混淆字符） */
  salary?: string
  company: string
  jobTitle: string
  /** 最后一条 HR 消息正文（已截断） */
  content: string
  /** 毫秒时间戳（后端返回 ISO 字符串，前端转换后存这里） */
  timestamp: number
  /** 是否有未读。后端无已读字段，用「HR 消息且未分类（intent 为空）」近似 */
  unread: boolean
  /** 该会话对应投递记录的匹配分（0-100）。null = 无投递记录（无从判断），
   *  与 0 分（判过且很差）语义不同，UI 提示需区分 */
  matchScore: number | null
  /** 后端 last_message_at 原文（本地镜像增量刷新比较用） */
  lastMessageAt?: string
  /**
   * BOSS 原生会话/用户标识（data-user-id / data-conversation-id 等，DOM 来源）。
   * 用于精确删除定位：同公司多会话时不再靠公司名子串猜。
   */
  bossId?: string
  /**
   * 平台岗位 ID：优先取后端 Job.platform_job_id（镜像/后端列表），
   * 用于删除后向后端精确标记 status=deleted，避免同公司多岗位全部被误标。
   */
  encryptJobId?: string
}

/** 左侧 Tab 导航项 */
export interface TabItem {
  key: TabKey
  label: string
}

/** 投递进度状态 */
export interface ApplyProgress {
  scanned: number // 已扫描岗位数
  /** 本轮是否真正完成了一次页面扫描（区分「扫到 0 个」与「没来得及扫」） */
  scanComplete: boolean
  matched: number // 匹配通过数
  applied: number // 已投递数
  skipped: number // 跳过数（低分/已投）
  failed: number // 投递失败数
  /** 未确认数（点了但平台未确认；不计入 applied/skipped/failed，也不推进投递目标） */
  unknown: number
  running: boolean
  logs: string[] // 操作日志
  /** 当前正在投递的岗位（实时显示用） */
  currentJob?: { title: string; company: string; score: number } | null
  /** 本批被质量判定拦截的岗位（岗位级，含原因，供面板核对） */
  blockedByQuality?: Array<{
    company: string
    title: string
    reason: string
    confidence?: number
  }>
}

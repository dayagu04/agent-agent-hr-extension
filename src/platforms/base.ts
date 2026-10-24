// 平台抽象基类 —— 所有平台适配器继承此类
import type { ApplyOutcome, JobCard, PlatformCode } from '../types'
import { assertToolExecutionActive } from '../tool-execution-guard'

/** 投递结果：区分平台已确认 / 无法确认 / 明确失败 */
export interface ApplyResult {
  outcome: ApplyOutcome
  message?: string
  /** 是否已发送打招呼语（BOSS 沟通场景） */
  greetingSent?: boolean
  /**
   * 该岗位此前已沟通过（如 BOSS「继续沟通」态）——不是本次投递失败，
   * 应计为跳过而非 failed；同时后端应补记真实投递记录便于跨轮去重。
   */
  alreadyApplied?: boolean
}

/** 投递上下文：由引擎注入，供适配器按需取招呼语等 */
export interface ApplyContext {
  /** 取该岗位的打招呼语（BOSS 需要；调后端复用主项目话术） */
  getGreeting?: () => Promise<string>
}

export abstract class BasePlatform {
  /** 平台中文名 */
  abstract readonly name: string
  /** 平台代号（与后端一致） */
  abstract readonly code: PlatformCode

  /**
   * 扫描当前页面的所有职位卡片。
   * 子类需根据各平台 DOM 结构实现选择器。
   */
  /** 扫描岗位卡片。withDetail=true 时额外打开详情读取 JD 全文（较慢，非所有平台支持）。 */
  abstract scanJobs(opts?: { withDetail?: boolean }): Promise<JobCard[]>

  /**
   * 对单个岗位执行投递动作（点击投递/沟通按钮 + 处理确认弹窗）。
   *
   * 返回 boolean 是旧签名（true=已点击）；新实现应返回 ApplyResult 以区分
   * 「平台已确认成功」与「点了但无法确认」——后者不应记为真实投递。
   */
  abstract applyJob(card: JobCard, ctx?: ApplyContext): Promise<boolean | ApplyResult>

  /**
   * 翻到下一页（可选；不支持返回 false）。
   * 默认不翻页，靠用户手动滚动/翻页后再次点「开始」。
   */
  async nextPage(): Promise<boolean> {
    return false
  }

  /**
   * 该平台的聊天/消息页地址（面板「跳转到聊天页」按钮用）。
   * null = 该平台无独立聊天页或尚未支持，UI 应隐藏跳转按钮。
   */
  readonly chatUrl: string | null = null

  // ---------- 通用工具 ----------

  /** 拟人随机延迟（防风控） */
  protected async delay(min: number, max: number): Promise<void> {
    assertToolExecutionActive()
    const ms = min + Math.random() * (max - min)
    await new Promise((r) => setTimeout(r, ms))
    assertToolExecutionActive()
  }

  /** 等待元素出现（轮询，超时返回 null） */
  protected waitFor(
    selector: string,
    root: ParentNode = document,
    timeout = 8000,
  ): Promise<HTMLElement | null> {
    assertToolExecutionActive()
    return new Promise((resolve, reject) => {
      const existing = root.querySelector(selector) as HTMLElement | null
      if (existing) return resolve(existing)
      const start = Date.now()
      const timer = setInterval(() => {
        try {
          assertToolExecutionActive()
        } catch (error) {
          clearInterval(timer)
          reject(error)
          return
        }
        const el = root.querySelector(selector) as HTMLElement | null
        if (el) {
          clearInterval(timer)
          resolve(el)
        } else if (Date.now() - start > timeout) {
          clearInterval(timer)
          resolve(null)
        }
      }, 300)
    })
  }

  /** 安全取文本 */
  protected text(el: Element | null | undefined): string {
    return (el?.textContent || '').trim()
  }

  /** 标记卡片已处理（视觉反馈：左边框变色） */
  markCard(card: JobCard, color: string): void {
    if (card.cardElement) {
      card.cardElement.style.borderLeft = `4px solid ${color}`
    }
  }
}

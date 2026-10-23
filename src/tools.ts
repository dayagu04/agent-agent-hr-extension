// 标准工具层 —— 把页面上能做的一件件事封装成 agent 可调用的原子操作。
//
// 约定：
//   - 每个工具 = 一个「页面原子动作」，参数与返回值都是纯数据；
//   - 是否该做由 agent 决策，这里不套产品策略（回不回、发哪份、点同意还是拒绝）；
//   - 每个工具执行后写一行 `tool name=<名字> status=ok|error ...` 日志（不含消息正文/文件名）；
//   - 入口是 remote 命令 `tool.call`，payload: { name, args }；
//     agent 也可以用 `list_tools` 拿到当前可用工具清单。
//
// 注意：send_message / send_resume / delete_thread / click_card 不可撤回。

import { diag } from './logger'
import { detectPlatform } from './platforms/factory'
import { loadConfig } from './config'
import { getOrchestrator } from './orchestrator'
import { fetchGreeting, recordApplication } from './api'
import { setPendingOpen } from './chat-store'
import { createToolDefinitions, type ToolResult } from './tool-definitions'
import type { PluginConfig } from './types'
export type { ToolResult, ToolSpec } from './tool-definitions'

function legacyTools(config: () => PluginConfig) {
  return createToolDefinitions({
    detectPlatform,
    getGreeting: (platform, job) => fetchGreeting(config(), platform, job),
    recordApplication: (...args) => recordApplication(config(), ...args),
    async navigate(url, pendingThread) {
      if (pendingThread) await setPendingOpen(pendingThread.company, pendingThread.jobTitle)
      setTimeout(() => location.assign(url), 800)
    },
    reload: () => { setTimeout(() => location.reload(), 800) },
    isRunning: () => getOrchestrator(config()).isRunning(),
    catalog: () => toolCatalog(),
  })
}

// Metadata discovery must not read stored credentials at module initialization.
const TOOLS = legacyTools(loadConfig)

export function toolCatalog(): Array<{ name: string; description: string; irreversible: boolean }> {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, irreversible: !!t.irreversible }))
}

/** 工具的完整定义（测试面板用：带参数示例） */
export function toolSpecs(): Array<{
  name: string
  description: string
  irreversible: boolean
  exampleArgs: Record<string, unknown>
}> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    irreversible: !!t.irreversible,
    exampleArgs: t.exampleArgs || {},
  }))
}

/** 执行一个工具。未知工具直接报错，不猜。 */
export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  if (!TOOLS.some((t) => t.name === name)) {
    diag('TOOL', `tool name=${name} status=error error=unknown_tool`)
    return { ok: false, error: 'unknown_tool' }
  }
  const started = Date.now()
  try {
    // An awaited page action may outlive an account/resume change in the panel.
    // Bind every phase to this invocation's account; never charge the new account.
    const cfg = loadConfig()
    const tool = legacyTools(() => cfg).find((t) => t.name === name)!
    const result = await tool.run(args)
    const detail = result.ok ? summarize(result.data) : `error=${result.error || 'unknown'}`
    diag('TOOL', `tool name=${name} status=${result.ok ? 'ok' : 'error'} ms=${Date.now() - started} ${detail}`)
    return result
  } catch (e) {
    diag('TOOL', `tool name=${name} status=error error=${(e as Error).name || 'Error'} ms=${Date.now() - started}`)
    return { ok: false, error: (e as Error).message || 'tool_failed' }
  }
}

/** 结果摘要（只记数量和字段存在性，不记正文/文件名） */
function summarize(data: unknown): string {
  if (data == null) return 'result=none'
  if (Array.isArray(data)) return `count=${data.length}`
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>
    const bits: string[] = []
    if (typeof o.count === 'number') bits.push(`count=${o.count}`)
    if (Array.isArray(o.messages)) {
      const msgs = o.messages as Array<{ sender?: string }>
      bits.push(`messages=${msgs.length}`)
      for (const k of ['hr', 'me', 'system']) {
        bits.push(`${k}=${msgs.filter((m) => m.sender === k).length}`)
      }
    }
    if (Array.isArray(o.jobs)) bits.push(`jobs=${o.jobs.length}`)
    if (typeof o.thread === 'object' && o.thread) bits.push('thread=1')
    return bits.length ? bits.join(' ') : 'result=object'
  }
  return `result=${String(data).slice(0, 40)}`
}

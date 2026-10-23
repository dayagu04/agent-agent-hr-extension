/** Serializable boundary between the trusted extension and the BOSS page. Never includes credentials. */
export interface ToolResult { ok: boolean; data?: unknown; error?: string }
export interface ToolDeclaration {
  name: string
  description: string
  irreversible: boolean
  parameters: Record<string, unknown>
}
export interface PageInvocation {
  commandKey: string
  name: string
  args: Record<string, unknown>
  context?: { greeting?: string; defaultResumeName?: string }
}
export type PageEffect =
  | { kind: 'navigate'; url: string; pendingThread?: { company: string; jobTitle: string } }
  | { kind: 'reload' }
  | { kind: 'application'; payload: Record<string, unknown> }
  | { kind: 'conversation_deleted'; payload: Record<string, unknown> }
export interface PageExecution { result: ToolResult; effects?: PageEffect[] }
export interface BossPageTools {
  run(invocation: PageInvocation): Promise<PageExecution>
  prepare(invocation: PageInvocation): Promise<ToolResult>
}
export const PAGE_RUNTIME_KEY = '__GUGU_BOSS_AGENT_TOOLS_V1__' as const

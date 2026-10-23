// Credential-free adapter around the shared atomic tool definitions.
import { BossPlatform } from '../../../src/platforms/boss'
import { createToolDefinitions, findJobCard, toolString } from '../../../src/tool-definitions'
import { assertToolExecutionActive, installToolExecutionGuard } from '../../../src/tool-execution-guard'
import { setPageResumeName } from './page/config'
import { toolCatalog, validateToolArgs } from './tools-contract'
import type { BossPageTools, PageEffect, PageExecution, PageInvocation, ToolResult } from './contracts'

const detectPlatform = () => location.hostname === 'www.zhipin.com' ? new BossPlatform() : null

function definitions(effects: PageEffect[], context: PageInvocation['context']) {
  return createToolDefinitions({
    detectPlatform,
    getGreeting: async () => context?.greeting || '',
    async recordApplication(platform, card, matchScore, outcome, error, greetingSent, runId, keyword) {
      effects.push({ kind: 'application', payload: {
        platform, platform_job_id: card.platformJobId,
        title: card.title, company: card.company || '', city: card.city || '',
        url: card.url || '', salary: card.salary || '', match_score: matchScore,
        outcome, error, greeting_sent: greetingSent, run_id: runId || null, keyword,
      } })
    },
    navigate(url, pendingThread) { effects.push({ kind: 'navigate', url, ...(pendingThread ? { pendingThread } : {}) }) },
    reload() { effects.push({ kind: 'reload' }) },
    // The extension runs atomic calls only; autonomous orchestration stays with the upstream agent.
    isRunning: () => false,
    async afterDeleted(target) {
      effects.push({ kind: 'conversation_deleted', payload: {
        platform: 'zhipin', company: target.company, job_title: target.jobTitle,
        reason: 'manual', encrypt_job_id: target.encryptJobId || '',
      } })
    },
    catalog: toolCatalog,
  })
}

interface ActiveLease { key: string; cancelled: boolean }
const MAX_RECEIPTS = 100
const MAX_COMMAND_KEYS = 2000

function validInvocation(value: unknown): value is PageInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).some((key) => !['commandKey', 'name', 'args', 'context'].includes(key))) return false
  if (typeof v.commandKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(v.commandKey) || typeof v.name !== 'string') return false
  if (v.context !== undefined) {
    if (!v.context || typeof v.context !== 'object' || Array.isArray(v.context)) return false
    if (!Object.entries(v.context).every(([key, entry]) => ['greeting', 'defaultResumeName'].includes(key) && typeof entry === 'string' && entry.length <= 20000)) return false
  }
  return true
}

const supportedPage = () => location.protocol === 'https:' && location.hostname === 'www.zhipin.com'

/** A document owns one execution lease. Re-injecting page.js preserves this instance and its receipts. */
export function createPageTools(): BossPageTools & { cancel(commandKey?: string): void } {
  let active: ActiveLease | null = null
  const seen = new Map<string, string>()
  const receipts = new Map<string, PageExecution>()

  function begin(key: string): ActiveLease {
    const lease = { key, cancelled: false }
    active = lease
    installToolExecutionGuard(() => {
      if (lease.cancelled) throw new Error('page_execution_cancelled')
    })
    return lease
  }
  function end(): void {
    installToolExecutionGuard(null)
    setPageResumeName()
    active = null
  }
  const failure = (error: string): PageExecution => ({ result: { ok: false, error } })
  return {
    cancel(commandKey) {
      if (active && (!commandKey || active.key === commandKey)) active.cancelled = true
    },
    async prepare(invocation) {
      if (!supportedPage()) return { ok: false, error: 'platform_not_supported' }
      if (!validInvocation(invocation)) return { ok: false, error: 'invalid_invocation' }
      const validation = validateToolArgs(invocation.name, invocation.args)
      if (!validation.ok) return validation
      if (invocation.name !== 'apply_job') return { ok: true }
      if (active) return { ok: false, error: 'page_busy' }
      const lease = begin(invocation.commandKey)
      try {
        const platform = detectPlatform()!
        const jobs = await platform.scanJobs()
        assertToolExecutionActive()
        const card = findJobCard(jobs, toolString(invocation.args, 'jobId'))
        if (!card) return { ok: false, error: 'job_not_found' }
        return { ok: true, data: { job: {
          platformJobId: card.platformJobId, title: card.title, company: card.company,
          city: card.city || '', salary: card.salary || '', description: card.description || '',
          url: card.url || '', jd: card.jd || '',
        } } }
      } catch {
        return { ok: false, error: lease.cancelled ? 'page_execution_cancelled' : 'page_prepare_failed' }
      } finally { end() }
    },
    async run(input) {
      if (!supportedPage()) return failure('platform_not_supported')
      if (!validInvocation(input)) return failure('invalid_invocation')
      const validation = validateToolArgs(input.name, input.args)
      if (!validation.ok) return { result: validation }
      // Copy before awaiting: a page caller cannot mutate arguments under an active command.
      const invocation = structuredClone(input)
      const fingerprint = JSON.stringify([invocation.name, invocation.args, invocation.context || {}])
      const previous = seen.get(invocation.commandKey)
      if (previous) {
        if (previous !== fingerprint) return failure('command_key_conflict')
        const receipt = receipts.get(invocation.commandKey)
        return receipt ? structuredClone(receipt) : failure('reconciliation_required')
      }
      if (active) return failure('page_busy')
      if (seen.size >= MAX_COMMAND_KEYS) return failure('page_receipt_capacity')
      seen.set(invocation.commandKey, fingerprint)
      const lease = begin(invocation.commandKey)
      const effects: PageEffect[] = []
      setPageResumeName(invocation.context?.defaultResumeName)
      let result: ToolResult
      try {
        const tool = definitions(effects, invocation.context).find((entry) => entry.name === invocation.name)!
        result = await tool.run(invocation.args)
        // A cancelled click may already have reached BOSS. Never turn that uncertainty into a retryable failure.
        if (lease.cancelled) result = { ok: false, error: 'reconciliation_required' }
      } catch {
        result = { ok: false, error: lease.cancelled ? 'reconciliation_required' : 'page_execution_failed' }
      } finally { end() }
      const execution: PageExecution = { result, ...(effects.length ? { effects } : {}) }
      receipts.set(invocation.commandKey, structuredClone(execution))
      if (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.keys().next().value!)
      return execution
    },
  }
}

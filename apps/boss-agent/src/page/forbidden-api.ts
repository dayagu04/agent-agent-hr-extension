// Build-time fail-closed replacement. MAIN cannot reach extension credentials or generic I/O.
function forbidden(..._args: unknown[]): never { throw new Error('page_network_not_available') }
export const login = forbidden as typeof import('../../../../src/api').login
export const fetchPluginConfig = forbidden as typeof import('../../../../src/api').fetchPluginConfig
export const reportToolResult = forbidden as typeof import('../../../../src/api').reportToolResult
export const matchJobs = forbidden as typeof import('../../../../src/api').matchJobs
export const fetchRules = forbidden as typeof import('../../../../src/api').fetchRules
export const fetchGreeting = forbidden as typeof import('../../../../src/api').fetchGreeting
export const logDecision = forbidden as typeof import('../../../../src/api').logDecision
export const syncChatOne = forbidden as typeof import('../../../../src/api').syncChatOne
export const fetchChatPlan = forbidden as typeof import('../../../../src/api').fetchChatPlan
export const judgeJobs = forbidden as typeof import('../../../../src/api').judgeJobs
export const fetchHRMessages = forbidden as typeof import('../../../../src/api').fetchHRMessages
export const markChatSent = forbidden as typeof import('../../../../src/api').markChatSent
export const reportChatOutcome = forbidden as typeof import('../../../../src/api').reportChatOutcome
export const markConversationDeleted = forbidden as typeof import('../../../../src/api').markConversationDeleted
export const recordApplication = forbidden as typeof import('../../../../src/api').recordApplication
export const reportOrchestratorEvent = forbidden as typeof import('../../../../src/api').reportOrchestratorEvent
export const reportThreadSnapshot = forbidden as typeof import('../../../../src/api').reportThreadSnapshot
export const reconcileThreads = forbidden as typeof import('../../../../src/api').reconcileThreads

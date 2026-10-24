// Build-time fail-closed replacement. MAIN cannot reach extension credentials or generic I/O.
function forbidden(..._args: unknown[]): never { throw new Error('page_storage_not_available') }
export const cacheScannedJobs = forbidden as typeof import('../../../../src/ledger').cacheScannedJobs
export const lookupCachedJob = forbidden as typeof import('../../../../src/ledger').lookupCachedJob
export const renderableMirror = forbidden as typeof import('../../../../src/ledger').renderableMirror
export const refreshMirror = forbidden as typeof import('../../../../src/ledger').refreshMirror
export const refreshChatList = forbidden as typeof import('../../../../src/ledger').refreshChatList
export const upsertMirrorFromDom = forbidden as typeof import('../../../../src/ledger').upsertMirrorFromDom
export const removeMirrorByKey = forbidden as typeof import('../../../../src/ledger').removeMirrorByKey
export const queueConversationDeletedMark = forbidden as typeof import('../../../../src/ledger').queueConversationDeletedMark
export const flushConversationDeletedMarks = forbidden as typeof import('../../../../src/ledger').flushConversationDeletedMarks
export const updateMirrorJobTitle = forbidden as typeof import('../../../../src/ledger').updateMirrorJobTitle
export const updateMirrorChatIdentity = forbidden as typeof import('../../../../src/ledger').updateMirrorChatIdentity
export const upsertMirrorFromSync = forbidden as typeof import('../../../../src/ledger').upsertMirrorFromSync

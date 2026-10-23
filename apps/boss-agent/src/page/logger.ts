// Page diagnostics must never forward raw BOSS objects or conversation content to logs.
// The trusted runtime reports only tool name, status and elapsed time.
export function diag(_tag: string, _message: string, _data?: unknown): void {}
export function hhmmss(d = new Date()): string { return d.toTimeString().slice(0, 8) }
export function setLogRunId(_id: string): void {}
export async function flushLogs(): Promise<void> {}

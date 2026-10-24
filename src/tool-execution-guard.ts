// Optional execution lease for the MV3 page runtime. Legacy userscript calls remain unchanged.
let guard: (() => void) | null = null

export function installToolExecutionGuard(next: (() => void) | null): void {
  guard = next
}

export function assertToolExecutionActive(): void {
  guard?.()
}

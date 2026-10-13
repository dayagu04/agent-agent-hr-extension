/** Field-level evidence can suspend writes for one adapter without hiding read-only diagnostics. */
export function applicationWriteAllowed(vendor: string): boolean {
  // A live Beisen application received writes in the wrong fields on 0.3.8.
  // Keep preview/diagnostics available, but require a verified mapping fix
  // before this vendor may write to a third-party application again.
  return vendor !== "beisen";
}

/** Local-only, closed-set diagnostics. Never accept labels, values, URLs or raw errors. */
export const DIAGNOSTIC_EVENTS = ["surface", "auth", "scan", "plan", "fill", "undo"] as const;
export const DIAGNOSTIC_OUTCOMES = ["ok", "empty", "blocked", "failed"] as const;
export const DIAGNOSTIC_REASONS = [
  "none", "not_form", "login_required", "profile_missing", "profile_unavailable",
  "no_controls", "no_semantics", "existing_values", "manual_only", "no_plan_match",
  "stale_preview", "vendor_write_paused", "write_unverified", "network", "server", "invalid_response", "other",
] as const;
export const DIAGNOSTIC_VENDORS = ["generic", "moka", "beisen", "bytedance", "tencent", "alibaba"] as const;
export const DIAGNOSTIC_COUNTS = [
  "documents", "controls", "semantic", "recognized", "existing", "inventory",
  "fillable", "selected", "written", "passes", "attempted", "retained", "cleared", "restored", "unverified", "skipped", "manualRequired", "manualOther",
  "manualUnknown", "manualMissing", "manualDynamic", "manualAttachment", "manualRepeat", "manualAmbiguous",
] as const;

export type DiagnosticEvent = typeof DIAGNOSTIC_EVENTS[number];
export type DiagnosticOutcome = typeof DIAGNOSTIC_OUTCOMES[number];
export type DiagnosticReason = typeof DIAGNOSTIC_REASONS[number];
export type DiagnosticVendor = typeof DIAGNOSTIC_VENDORS[number];
export type DiagnosticCount = typeof DIAGNOSTIC_COUNTS[number];
export type DiagnosticInput = {
  event: DiagnosticEvent;
  outcome: DiagnosticOutcome;
  reason?: DiagnosticReason;
  vendor: DiagnosticVendor;
  counts?: Partial<Record<DiagnosticCount, number>>;
};
export type DiagnosticRecord = Required<Omit<DiagnosticInput, "counts">> & {
  at: number;
  counts: Partial<Record<DiagnosticCount, number>>;
};

const allowedEvents = new Set<string>(DIAGNOSTIC_EVENTS);
const allowedOutcomes = new Set<string>(DIAGNOSTIC_OUTCOMES);
const allowedReasons = new Set<string>(DIAGNOSTIC_REASONS);
const allowedVendors = new Set<string>(DIAGNOSTIC_VENDORS);
const allowedCounts = new Set<string>(DIAGNOSTIC_COUNTS);
const MAX_RECORDS = 80;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function sanitizeDiagnostic(input: unknown, now = Date.now()): DiagnosticRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  if (!allowedEvents.has(String(row.event)) || !allowedOutcomes.has(String(row.outcome))) return null;
  const rawCounts = row.counts && typeof row.counts === "object" && !Array.isArray(row.counts)
    ? row.counts as Record<string, unknown> : {};
  const counts: DiagnosticRecord["counts"] = {};
  for (const [key, value] of Object.entries(rawCounts)) {
    if (allowedCounts.has(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      counts[key as DiagnosticCount] = Math.min(value, 9_999);
    }
  }
  return {
    at: now,
    event: row.event as DiagnosticEvent,
    outcome: row.outcome as DiagnosticOutcome,
    reason: allowedReasons.has(String(row.reason)) ? row.reason as DiagnosticReason : "other",
    vendor: allowedVendors.has(String(row.vendor)) ? row.vendor as DiagnosticVendor : "generic",
    counts,
  };
}

export function boundedDiagnostics(stored: unknown, next?: DiagnosticRecord, now = Date.now()): DiagnosticRecord[] {
  const prior = Array.isArray(stored) ? stored : [];
  const safe = prior.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const at = (item as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at > now || now - at > MAX_AGE_MS) return [];
    const record = sanitizeDiagnostic(item, at);
    return record ? [record] : [];
  });
  if (next) safe.push(next);
  return safe.slice(-MAX_RECORDS);
}

export function formatDiagnostics(records: DiagnosticRecord[]): string {
  if (!records.length) return "暂无诊断记录，点击开始填写后可查看。";
  return records.map((row) => {
    const counts = DIAGNOSTIC_COUNTS.flatMap((key) => row.counts[key] === undefined ? [] : [`${key}=${row.counts[key]}`]);
    return `${new Date(row.at).toLocaleTimeString("zh-CN", { hour12: false })} ${row.vendor} ${row.event}/${row.outcome}/${row.reason}${counts.length ? ` ${counts.join(" ")}` : ""}`;
  }).join("\n");
}

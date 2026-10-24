import assert from "node:assert/strict";
import test from "node:test";

import { boundedDiagnostics, formatDiagnostics, sanitizeDiagnostic } from "../src/diagnostics.ts";

test("diagnostics retain only closed-set stage counts in a bounded session log", () => {
  const now = 1_700_000_000_000;
  const record = sanitizeDiagnostic({
    event: "scan", outcome: "empty", reason: "no_semantics", vendor: "beisen",
    url: "https://example.invalid/private", label: "private applicant name", value: "private address",
    error: "private raw exception", counts: { controls: 14, manualUnknown: 14, injected: 7, existing: -1, inventory: 100_000 },
  }, now);
  assert.deepEqual(record, {
    at: now, event: "scan", outcome: "empty", reason: "no_semantics", vendor: "beisen",
    counts: { controls: 14, manualUnknown: 14, inventory: 9_999 },
  });
  assert.equal(sanitizeDiagnostic({ event: "private", outcome: "ok", vendor: "beisen" }, now), null);
  assert.equal(sanitizeDiagnostic({ event: "scan", outcome: "private", vendor: "beisen" }, now), null);
  assert.equal(sanitizeDiagnostic({ event: "scan", outcome: "ok", vendor: "https://example.invalid" }, now)?.vendor, "generic");
  assert.ok(!formatDiagnostics([record!]).includes("private"));
  assert.ok(!formatDiagnostics([record!]).includes("example.invalid"));
  const writeResult = sanitizeDiagnostic({
    event: "fill", outcome: "failed", reason: "write_unverified", vendor: "beisen",
    counts: { selected: 3, attempted: 2, retained: 1, unverified: 1, value: "private" },
  }, now);
  assert.equal(formatDiagnostics([writeResult!]).includes("retained=1 unverified=1"), true);
  assert.equal(formatDiagnostics([writeResult!]).includes("private"), false);

  const entries = Array.from({ length: 85 }, (_, index) => sanitizeDiagnostic({
    event: "scan", outcome: "ok", vendor: "beisen", counts: { controls: index },
  }, now - 85 + index)!);
  const old = sanitizeDiagnostic({ event: "surface", outcome: "ok", vendor: "moka" }, now - 25 * 60 * 60 * 1000)!;
  const bounded = boundedDiagnostics([old, ...entries], undefined, now);
  assert.equal(bounded.length, 80);
  assert.equal(bounded[0].counts.controls, 5);
  assert.equal(bounded.at(-1)?.counts.controls, 84);
});

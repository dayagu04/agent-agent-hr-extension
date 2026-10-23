import assert from "node:assert/strict";
import test from "node:test";

import { formatStructureReport } from "../src/structure-report.ts";

test("copied structure report keeps only bounded structural tokens, never source strings", () => {
  const report = formatStructureReport("beisen", 1, 47, [{
    document: 0,
    tag: "INPUT",
    inputType: "text",
    parent: "DIV",
    siblingPosition: "last",
    parentControls: 2,
    labelSource: "nearby",
    semantic: "email",
    matched: true,
    outcome: "cleared",
  }, {
    document: 1,
    tag: "private applicant name",
    inputType: "test@example.invalid",
    parent: "https://example.invalid/apply",
    siblingPosition: "private phone",
    parentControls: 100_000,
    labelSource: "private label",
    semantic: "private value",
    matched: false,
    outcome: "private failure",
    resumeField: "private field", resumeSection: "private resume", result: "private result",
  }]);
  assert.match(report, /semantic=email .*planned=yes write=cleared/);
  assert.match(report, /labelSource=other semantic=unknown .*planned=no write=other/);
  assert.ok(!/private|test@example|example\.invalid/.test(report));
  assert.match(report, /nearbyControls=9999/);
});

test("structure report includes at most 80 rows", () => {
  const row = {
    document: 0, tag: "INPUT", inputType: "text", parent: "DIV", siblingPosition: "only",
    parentControls: 1, labelSource: "none", semantic: "unknown", matched: false, outcome: "none",
  };
  const report = formatStructureReport("beisen", 1, 100, Array.from({ length: 100 }, () => row));
  assert.equal(report.split("\n").length, 81);
  assert.match(report.split("\n")[0], /shown=80 omitted=20/);
});

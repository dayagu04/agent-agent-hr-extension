import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { matchDescriptor, summarizeRequiredCoverage, type FieldDecision, type FieldDescriptor } from "../src/field-matcher.ts";
import { EMPTY_PROFILE, type ProfileData } from "../src/types.ts";

interface ContractCase {
  id: string;
  profile: Partial<ProfileData>;
  field: FieldDescriptor;
  expected: Partial<FieldDecision>;
}

const fixturePath = fileURLToPath(new URL("./fixtures/field-matcher.json", import.meta.url));
const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as ContractCase[];

test("sanitized field contract is exact and has zero unexpected fills", () => {
  let correct = 0;
  let unexpectedFills = 0;
  for (const contract of cases) {
    const profile = { ...EMPTY_PROFILE, ...contract.profile } as ProfileData;
    const decision = matchDescriptor(contract.field, profile);
    if (contract.expected.action !== "fill" && decision.action === "fill") unexpectedFills += 1;
    const actual = Object.fromEntries(Object.keys(contract.expected).map((key) => [key, decision[key as keyof FieldDecision]]));
    if (JSON.stringify(actual) === JSON.stringify(contract.expected)) correct += 1;
    else assert.deepEqual(actual, contract.expected, contract.id);
  }
  assert.equal(unexpectedFills, 0);
  assert.equal(correct, cases.length);
  process.stdout.write(`autofill contract: ${correct}/${cases.length} exact, ${unexpectedFills} unexpected fills\n`);
});

test("an explicit user mapping still respects control compatibility", () => {
  const profile = { ...EMPTY_PROFILE, email: "candidate@example.com" } as ProfileData;
  const decision = matchDescriptor({ label: "自定义字段", controlType: "date" }, profile, "email");
  assert.deepEqual(decision, {
    action: "manual",
    profileKey: "email",
    confidence: 0.99,
    reason: "unsupported_control",
    value: null,
  });
});

test("visible required manual fields are counted instead of silently omitted", () => {
  const profile = { ...EMPTY_PROFILE, fullName: "测试用户" } as ProfileData;
  const fill = matchDescriptor({ label: "姓名", controlType: "text", required: true }, profile);
  const unknown = matchDescriptor({ label: "自定义必答题", controlType: "textarea", required: true }, profile);
  const hidden = matchDescriptor({ label: "邮箱", controlType: "hidden", required: true, hidden: true }, profile);
  assert.deepEqual(summarizeRequiredCoverage([
    { required: true, decision: fill },
    { required: true, decision: unknown },
    { required: true, decision: hidden },
  ]), {
    requiredTotal: 2,
    requiredFillable: 1,
    requiredManual: 1,
    complete: false,
  });
});

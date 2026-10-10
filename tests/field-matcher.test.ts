import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isAiPolishAllowed, matchDescriptor, summarizeRequiredCoverage, type FieldDecision, type FieldDescriptor } from "../src/field-matcher.ts";
import { EMPTY_PROFILE, type ProfileData, type ProfileFieldKey, type StructuredEntryField, type StructuredEntryKind } from "../src/types.ts";

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

test("AI polish is limited to narrative fields inside repeated records", () => {
  const repeated = (kind: StructuredEntryKind, field: StructuredEntryField): FieldDescriptor => ({
    label: "重复经历字段",
    controlType: "text",
    repeated: {
      groupKey: `${kind}-row-1`,
      groupLabel: "重复经历第 1 行",
      kind,
      field,
      targetEntryId: `${kind}-1`,
    },
  });
  const policyCases: Array<[StructuredEntryKind, StructuredEntryField, ProfileFieldKey, boolean]> = [
    ["experience", "description", "experience", true],
    ["experience", "organization", "experience", false],
    ["experience", "role", "experience", false],
    ["education", "school", "school", false],
    ["project", "name", "projects", false],
    ["experience", "location", "experience", false],
    ["experience", "startDate", "experience", false],
  ];
  for (const [kind, field, key, expected] of policyCases) {
    assert.equal(isAiPolishAllowed(repeated(kind, field), key), expected, `${kind}.${field}`);
  }
  assert.equal(isAiPolishAllowed({ label: "个人简介", controlType: "textarea" }, "summary"), true);
  assert.equal(isAiPolishAllowed({ label: "姓名", controlType: "text" }, "fullName"), false);
});

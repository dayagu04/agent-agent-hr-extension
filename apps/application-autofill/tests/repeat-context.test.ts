import assert from "node:assert/strict";
import test from "node:test";

import {
  inferStructuredEntryField,
  inferStructuredEntryKind,
  resolveRepeatedValue,
  structuredEntryOptions,
} from "../src/repeat-context.ts";
import { EMPTY_PROFILE, type ProfileData } from "../src/types.ts";

function profile(): ProfileData {
  return {
    ...EMPTY_PROFILE,
    educationEntries: [{
      id: "edu-1",
      school: "示例大学",
      major: "计算机科学",
      degree: "硕士",
      startDate: "2021-09",
      endDate: "2024-06",
      gpa: "3.8",
      description: "",
    }],
    experienceEntries: [
      { id: "work-1", organization: "示例芯片公司", role: "工程师", startDate: "2024-01", endDate: "2025-01", location: "上海市", description: "脱敏职责" },
      { id: "work-2", organization: "示例互联网公司", role: "实习生", startDate: "2023-06", endDate: "2023-12", location: "北京市", description: "脱敏职责" },
    ],
    projectEntries: [],
    awardEntries: [],
  };
}

test("ATS group and field inference stays within an explicit repeated section", () => {
  assert.equal(inferStructuredEntryKind("semi-form-list work-experience-item 工作经历"), "experience");
  assert.equal(inferStructuredEntryKind("普通联系信息"), null);
  assert.equal(inferStructuredEntryField("experience", "公司名称 | Company"), "organization");
  assert.equal(inferStructuredEntryField("experience", "应聘职位"), null);
  assert.equal(inferStructuredEntryField("education", "学校名称"), "school");
});

test("repeated rows expose explicit record choices and never default to the first entry", () => {
  const data = profile();
  assert.deepEqual(structuredEntryOptions(data, "experience"), [
    { id: "work-1", label: "第 1 条 · 示例芯片公司 · 工程师" },
    { id: "work-2", label: "第 2 条 · 示例互联网公司 · 实习生" },
  ]);
  assert.deepEqual(resolveRepeatedValue(data, {
    groupKey: "row-1",
    groupLabel: "工作 / 实习经历第 1 行",
    kind: "experience",
    field: "organization",
  }), { value: null, reason: "repeated_group_unbound" });
});

test("a bound repeated row resolves only the selected structured entry", () => {
  const data = profile();
  assert.deepEqual(resolveRepeatedValue(data, {
    groupKey: "row-1",
    groupLabel: "工作 / 实习经历第 1 行",
    kind: "experience",
    field: "organization",
    targetEntryId: "work-2",
  }), { value: "示例互联网公司", reason: "record_value_ready" });
});

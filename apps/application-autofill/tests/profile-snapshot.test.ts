import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProfileSnapshot } from "../src/profile-snapshot.ts";

test("one server snapshot becomes the bounded local profile used by the page scanner", () => {
  const snapshot = normalizeProfileSnapshot({
    schemaVersion: 1,
    account: { userId: 7, displayName: "示例账号" },
    draftRevision: 4,
    publishedRevision: 4,
    publishedStatus: "active",
    hasPendingImport: false,
    hasUnpublishedDraft: false,
    profile: {
      basic: {
        legal_name_zh: "示例姓名", mobile_number: "13800000000", contact_email: "person@example.invalid",
        residence_city: "示例城市", personal_summary: "示例简介",
      },
      educations: [{ recordId: "education1", school_name: "示例大学", major: "软件工程", education_level: "本科" }],
      employments: [{ recordId: "employment1", employer_name: "示例单位", job_title: "工程师", responsibilities: "示例职责" }],
      practices: [{ recordId: "practice01", organization_name: "示例机构", role_title: "志愿者", tasks: "示例任务" }],
      projects: [{ recordId: "project001", name: "示例项目", role_title: "开发", results: "示例结果" }],
      awards: [{ recordId: "award0001", name: "示例奖项", issuer: "示例组织" }],
      skills: [{ recordId: "skill0001", name: "TypeScript" }, { recordId: "skill0002", name: "Python" }],
      links: [{ recordId: "link00001", platform: "GitHub", url: "https://example.invalid/profile" }],
    },
  });
  assert.equal(snapshot.profile.fullName, "示例姓名");
  assert.equal(snapshot.profile.email, "person@example.invalid");
  assert.equal(snapshot.profile.school, "示例大学");
  assert.equal(snapshot.profile.skills, "TypeScript、Python");
  assert.equal(snapshot.profile.github, "https://example.invalid/profile");
  assert.deepEqual(snapshot.profile.experienceEntries.map((entry) => entry.id), ["employment1", "practice01"]);
  assert.deepEqual(snapshot.recordOptions.employment.map((entry) => entry.recordId), ["employment1", "practice01"]);
});

test("snapshot rejects unknown versions, invalid records and oversized values", () => {
  const base = {
    schemaVersion: 1, account: { userId: 7, displayName: "示例账号" }, draftRevision: 1,
    publishedRevision: 1, publishedStatus: "active", profile: { basic: {} },
  };
  assert.throws(() => normalizeProfileSnapshot({ ...base, schemaVersion: 2 }), /版本/);
  assert.throws(() => normalizeProfileSnapshot({ ...base, profile: { basic: {}, skills: [{ recordId: "bad", name: "x" }] } }), /标识/);
  assert.throws(() => normalizeProfileSnapshot({ ...base, profile: { basic: { legal_name_zh: "x".repeat(4_001) } } }), /字段格式/);
});

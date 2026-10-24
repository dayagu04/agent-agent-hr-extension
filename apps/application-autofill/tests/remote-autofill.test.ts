import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProfileFillPlan, normalizeRemoteFillPlan, publishedProfileRevision, toRemoteDetectedField, type RemoteDetectedField } from "../src/remote-autofill.ts";
import type { FieldDescriptor } from "../src/field-matcher.ts";

const baseDescriptor: FieldDescriptor = {
  label: "姓名",
  ariaLabel: "候选人姓名",
  placeholder: "请输入姓名",
  name: "candidateName",
  controlType: "text",
  required: true,
  hidden: false,
  disabled: false,
  readOnly: false,
  hasValue: false,
  options: [],
};

test("empty remote profile has a stable zero revision", () => {
  assert.equal(publishedProfileRevision(null), 0);
  assert.equal(publishedProfileRevision({
    draftRevision: 0,
    publishedRevision: 0,
    publishedStatus: "empty",
    hasPendingImport: false,
    hasUnpublishedDraft: false,
    recordOptions: {},
  }), 0);
});

function validPlan(value: string | string[] = "测试姓名") {
  return {
    schemaVersion: 1,
    decisions: [{
      fieldId: "field-1",
      action: "fill",
      canonicalKey: "full_name",
      confidence: 1,
      reason: "value_ready",
      value,
      sensitivity: "direct_identifier",
    }],
    coverage: { requiredTotal: 1, requiredFillable: 1, requiredManual: 0, complete: true },
    resumeId: 7,
    resumeVariantId: null,
    sourceMode: "raw",
    vendor: "moka",
    autoSubmit: false,
  };
}

test("remote descriptor contains only the bounded plan contract", () => {
  const field = toRemoteDetectedField("field-1", baseDescriptor);
  assert.deepEqual(field, {
    fieldId: "field-1",
    label: "姓名",
    ariaLabel: "候选人姓名",
    placeholder: "请输入姓名",
    name: "candidateName",
    controlType: "text",
    required: true,
    hidden: false,
    disabled: false,
    readOnly: false,
    hasValue: false,
    options: [],
  });
  const serialized = JSON.stringify(field);
  assert.doesNotMatch(serialized, /selector|outerHTML|innerHTML|currentValue|url/i);
});

test("descriptor hints redact contact details, long identifiers, and URLs before transmission", () => {
  const field = toRemoteDetectedField("field-1", {
    ...baseDescriptor,
    label: "联系 13800000000",
    ariaLabel: "example@example.com",
    placeholder: "证件 123456789012345678",
    name: "https://example.test/private?token=sample",
    options: [{ value: "1234567890123456", label: "备用 13900000000", disabled: false }],
  })!;
  const serialized = JSON.stringify(field);
  assert.doesNotMatch(serialized, /13800000000|13900000000|example@example.com|1234567890123456|token=sample/);
  assert.match(serialized, /\[redacted\]/);
});

test("unsupported controls are manual and repeated rows require an explicit record binding", () => {
  assert.equal(toRemoteDetectedField("field-1", { ...baseDescriptor, controlType: "file" }), null);
  assert.equal(toRemoteDetectedField("field-1", { ...baseDescriptor, controlType: "combobox" }), null);
  assert.equal(toRemoteDetectedField("field-1", {
    ...baseDescriptor,
    repeated: { groupKey: "g1", groupLabel: "教育经历第 1 行", kind: "education", field: "school" },
  })?.recordKind, "education");
  assert.equal(toRemoteDetectedField("field-1", {
    ...baseDescriptor,
    repeated: { groupKey: "g1", groupLabel: "教育经历第 1 行", kind: "education", field: "school" },
  })?.recordField, "school");
  assert.equal(toRemoteDetectedField("field-1", {
    ...baseDescriptor,
    repeated: { groupKey: "g1", groupLabel: "教育经历第 1 行", kind: "education", field: "school", targetEntryId: "record001" },
  })?.recordId, "record001");
});

test("published profile plan validates version, scope, and repeat binding", () => {
  const field = toRemoteDetectedField("field-1", baseDescriptor)!;
  const fields = new Map([[field.fieldId, field]]);
  const profilePlan = { ...validPlan(), schemaVersion: 2, publishedRevision: 3 };
  assert.equal(normalizeProfileFillPlan(profilePlan, fields, 3, "moka").decisions[0].value, "测试姓名");
  assert.throws(() => normalizeProfileFillPlan(profilePlan, fields, 2, "moka"), /版本/);
  assert.throws(() => normalizeProfileFillPlan(profilePlan, fields, 3, "beisen"), /版本/);
  const repeated = { ...field, recordKind: "education" };
  assert.throws(() => normalizeProfileFillPlan(profilePlan, new Map([[field.fieldId, repeated]]), 3, "moka"), /未绑定/);
  assert.throws(() => normalizeProfileFillPlan({
    ...profilePlan, decisions: [{ ...profilePlan.decisions[0], canonicalKey: "identity_number", sensitivity: "restricted" }],
  }, fields, 3, "moka"), /受限/);
});

test("server must acknowledge overwrite and cannot fill existing non-text controls", () => {
  const field = { ...toRemoteDetectedField("field-1", baseDescriptor)!, hasValue: true };
  const fields = new Map([[field.fieldId, field]]);
  const profilePlan = { ...validPlan(), schemaVersion: 2, publishedRevision: 3, overwriteExisting: true };
  assert.throws(() => normalizeProfileFillPlan(profilePlan, fields, 3, "moka"), /覆盖权限/);
  assert.throws(() => normalizeProfileFillPlan({ ...profilePlan, overwriteExisting: false }, fields, 3, "moka"), /不可覆盖/);
  assert.throws(() => normalizeProfileFillPlan({ ...profilePlan, overwriteExisting: false }, fields, 3, "moka", true), /覆盖权限/);
  assert.equal(normalizeProfileFillPlan(profilePlan, fields, 3, "moka", true).decisions[0].value, "测试姓名");
  const select = { ...field, controlType: "select" as const };
  assert.throws(() => normalizeProfileFillPlan(profilePlan, new Map([[field.fieldId, select]]), 3, "moka", true), /不可覆盖/);
  const readonly = { ...field, readOnly: true };
  assert.throws(() => normalizeProfileFillPlan(profilePlan, new Map([[field.fieldId, readonly]]), 3, "moka", true), /不可覆盖/);
});

test("multiple native select is represented explicitly", () => {
  const field = toRemoteDetectedField("field-1", { ...baseDescriptor, controlType: "select", multiple: true });
  assert.equal(field?.controlType, "multi_select");
});

test("valid plan remains preview-only and is normalized", () => {
  const field = toRemoteDetectedField("field-1", baseDescriptor)!;
  const plan = normalizeRemoteFillPlan(validPlan(), new Map([[field.fieldId, field]]));
  assert.equal(plan.autoSubmit, false);
  assert.equal(plan.decisions[0].value, "测试姓名");
});

test("remote plan fails closed on unsafe or incompatible responses", () => {
  const field = toRemoteDetectedField("field-1", baseDescriptor)!;
  const fields = new Map<string, RemoteDetectedField>([[field.fieldId, field]]);
  assert.throws(() => normalizeRemoteFillPlan({ ...validPlan(), autoSubmit: true }, fields), /版本不兼容/);
  assert.throws(() => normalizeRemoteFillPlan({
    ...validPlan(),
    decisions: [{ ...validPlan().decisions[0], fieldId: "unknown" }],
  }, fields), /未知字段/);
  assert.throws(() => normalizeRemoteFillPlan(validPlan(["不应写入文本框"]), fields), /控件不兼容/);
  assert.throws(() => normalizeRemoteFillPlan({
    ...validPlan(),
    decisions: [{ ...validPlan().decisions[0], action: "manual", value: "不应携带值" }],
  }, fields), /非填写动作/);
  assert.throws(() => normalizeRemoteFillPlan({
    ...validPlan(),
    decisions: [{ ...validPlan().decisions[0], canonicalKey: "identity_number", sensitivity: "restricted" }],
  }, fields), /受限字段/);
  assert.throws(() => normalizeRemoteFillPlan({ ...validPlan(), decisions: [] }, fields), /字段不完整/);
});

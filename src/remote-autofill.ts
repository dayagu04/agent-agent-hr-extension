import type { FieldDescriptor } from "./field-matcher.ts";

export interface RemoteResumeSummary {
  resumeId: number;
  name: string;
}

export interface RemoteDetectedField {
  fieldId: string;
  label: string;
  ariaLabel: string;
  placeholder: string;
  name: string;
  controlType: "text" | "textarea" | "email" | "tel" | "url" | "date" | "month" | "number" | "select" | "multi_select" | "radio" | "checkbox";
  required: boolean;
  hidden: boolean;
  disabled: boolean;
  readOnly: boolean;
  hasValue: boolean;
  options: Array<{ value: string; label: string; disabled: boolean }>;
  recordKind?: string;
  recordId?: string;
  recordField?: string;
}

export interface RemoteProfileStatus {
  draftRevision: number;
  publishedRevision: number;
  publishedStatus: "active" | "empty";
  hasPendingImport: boolean;
  hasUnpublishedDraft: boolean;
  recordOptions: Record<string, Array<{ recordId: string; label: string }>>;
}

export function publishedProfileRevision(status: RemoteProfileStatus | null): number {
  return status?.publishedRevision ?? 0;
}

export interface RemotePlanDecision {
  fieldId: string;
  action: "fill" | "manual" | "skip";
  canonicalKey: string | null;
  confidence: number;
  reason: string;
  value: string | string[] | null;
  sensitivity: string;
}

export interface RemoteFillPlan {
  schemaVersion: 1;
  decisions: RemotePlanDecision[];
  coverage: {
    requiredTotal: number;
    requiredFillable: number;
    requiredManual: number;
    complete: boolean;
  };
  resumeId: number;
  resumeVariantId: number | null;
  sourceMode: string;
  vendor: string;
  autoSubmit: false;
}

export interface ProfileFillPlan extends Omit<RemoteFillPlan, "schemaVersion" | "resumeId" | "resumeVariantId" | "sourceMode"> {
  schemaVersion: 2;
  publishedRevision: number;
  overwriteExisting: boolean;
}

const REMOTE_CONTROL_TYPES = new Set<RemoteDetectedField["controlType"]>([
  "text", "textarea", "email", "tel", "url", "date", "month", "number", "select", "multi_select", "radio", "checkbox",
]);
const RESTRICTED_REMOTE_KEYS = new Set(["identity_number"]);
const OVERWRITABLE_TEXT_CONTROLS = new Set<RemoteDetectedField["controlType"]>([
  "text", "textarea", "email", "tel", "url", "date", "month", "number",
]);

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

const PRIVATE_DESCRIPTOR_PATTERNS = [
  /https?:\/\/[^\s<>"']+/gi,
  /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /(?<!\d)\d{15,}(?!\d)/g,
];

function safeDescriptorText(value: unknown, limit: number): string {
  let result = text(value, limit);
  for (const pattern of PRIVATE_DESCRIPTOR_PATTERNS) result = result.replace(pattern, "[redacted]");
  return result;
}

/** Build the server contract without current values, selectors, DOM or URL. */
export function toRemoteDetectedField(fieldId: string, descriptor: FieldDescriptor): RemoteDetectedField | null {
  if (!fieldId || fieldId.length > 128) return null;
  const controlType = descriptor.controlType === "select" && descriptor.multiple
    ? "multi_select"
    : descriptor.controlType as RemoteDetectedField["controlType"];
  if (!REMOTE_CONTROL_TYPES.has(controlType)) return null;
  return {
    fieldId,
    label: safeDescriptorText(descriptor.label, 300),
    ariaLabel: safeDescriptorText(descriptor.ariaLabel, 300),
    placeholder: safeDescriptorText(descriptor.placeholder, 300),
    name: safeDescriptorText(descriptor.name, 300),
    controlType,
    required: Boolean(descriptor.required),
    hidden: Boolean(descriptor.hidden),
    disabled: Boolean(descriptor.disabled),
    readOnly: Boolean(descriptor.readOnly),
    hasValue: Boolean(descriptor.hasValue),
    options: (descriptor.options ?? []).slice(0, 100).map((option) => ({
      value: safeDescriptorText(option.value, 500),
      label: safeDescriptorText(option.label, 500),
      disabled: Boolean(option.disabled),
    })),
    ...(descriptor.repeated ? {
      recordKind: descriptor.repeated.kind === "experience" ? "employment" : descriptor.repeated.kind,
      recordField: descriptor.repeated.field,
      ...(descriptor.repeated.targetEntryId ? { recordId: descriptor.repeated.targetEntryId } : {}),
    } : {}),
  };
}
function isPlanValue(value: unknown): value is string | string[] | null {
  if (value === null) return true;
  if (typeof value === "string") return value.length <= 20_000;
  return Array.isArray(value)
    && value.length <= 100
    && value.every((item) => typeof item === "string" && item.length <= 5_000);
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

/** Treat every server response as untrusted and fail the whole plan closed. */
export function normalizeRemoteFillPlan(
  raw: unknown,
  allowedFields: Set<string> | Map<string, RemoteDetectedField>,
): RemoteFillPlan {
  if (!raw || typeof raw !== "object") throw new Error("云端填写计划格式无效。 ");
  const body = raw as Record<string, unknown>;
  if (body.schemaVersion !== 1 || body.autoSubmit !== false || !Array.isArray(body.decisions)) {
    throw new Error("云端填写计划版本不兼容。 ");
  }
  const allowedFieldIds = allowedFields instanceof Map ? new Set(allowedFields.keys()) : allowedFields;
  const seen = new Set<string>();
  const decisions: RemotePlanDecision[] = body.decisions.map((item) => {
    if (!item || typeof item !== "object") throw new Error("云端填写计划字段无效。 ");
    const decision = item as Record<string, unknown>;
    const fieldId = text(decision.fieldId, 128);
    const action = decision.action;
    const confidence = Number(decision.confidence);
    if (!allowedFieldIds.has(fieldId) || seen.has(fieldId)) throw new Error("云端填写计划包含未知字段。 ");
    if (!new Set(["fill", "manual", "skip"]).has(String(action))) throw new Error("云端填写计划动作无效。 ");
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("云端填写计划置信度无效。 ");
    if (!isPlanValue(decision.value)) throw new Error("云端填写计划值无效。 ");
    if (action === "fill" && decision.value === null) throw new Error("云端填写计划缺少值。 ");
    if (action !== "fill" && decision.value !== null) throw new Error("云端填写计划的非填写动作携带了值。 ");
    if (action === "fill" && allowedFields instanceof Map) {
      const field = allowedFields.get(fieldId);
      const expectsArray = field?.controlType === "multi_select" || field?.controlType === "checkbox";
      if (!field || (expectsArray ? !Array.isArray(decision.value) : typeof decision.value !== "string")) {
        throw new Error("云端填写计划值与控件不兼容。 ");
      }
    }
    if (action === "fill" && (decision.sensitivity === "restricted" || RESTRICTED_REMOTE_KEYS.has(String(decision.canonicalKey)))) {
      throw new Error("云端填写计划试图处理受限字段。 ");
    }
    seen.add(fieldId);
    return {
      fieldId,
      action: action as RemotePlanDecision["action"],
      canonicalKey: decision.canonicalKey === null ? null : text(decision.canonicalKey, 64),
      confidence,
      reason: text(decision.reason, 120),
      value: decision.value,
      sensitivity: text(decision.sensitivity, 40),
    };
  });
  if (seen.size !== allowedFieldIds.size) throw new Error("云端填写计划字段不完整。 ");

  const coverage = body.coverage as Record<string, unknown> | undefined;
  const requiredTotal = nonNegativeInteger(coverage?.requiredTotal);
  const requiredFillable = nonNegativeInteger(coverage?.requiredFillable);
  const requiredManual = nonNegativeInteger(coverage?.requiredManual);
  const resumeId = nonNegativeInteger(body.resumeId);
  if (requiredTotal === null || requiredFillable === null || requiredManual === null || resumeId === null || resumeId < 1) {
    throw new Error("云端填写计划统计无效。 ");
  }
  return {
    schemaVersion: 1,
    decisions,
    coverage: { requiredTotal, requiredFillable, requiredManual, complete: Boolean(coverage?.complete) },
    resumeId,
    resumeVariantId: body.resumeVariantId === null ? null : nonNegativeInteger(body.resumeVariantId),
    sourceMode: text(body.sourceMode, 40),
    vendor: text(body.vendor, 40),
    autoSubmit: false,
  };
}

/** The v2 contract has one published profile, never a selected resume. */
export function normalizeProfileFillPlan(
  raw: unknown,
  allowedFields: Map<string, RemoteDetectedField>,
  expectedRevision: number,
  expectedVendor: string,
  expectedOverwriteExisting = false,
): ProfileFillPlan {
  if (!raw || typeof raw !== "object") throw new Error("云端填写计划格式无效。");
  const body = raw as Record<string, unknown>;
  if (body.schemaVersion !== 2 || body.autoSubmit !== false || body.publishedRevision !== expectedRevision || body.vendor !== expectedVendor) {
    throw new Error("云端填写计划版本或资料版本不一致。");
  }
  if ((body.overwriteExisting === true) !== expectedOverwriteExisting) {
    throw new Error("云端填写计划覆盖权限不一致。");
  }
  if (!Array.isArray(body.decisions) || body.decisions.length !== allowedFields.size) {
    throw new Error("云端填写计划字段数量不一致。");
  }
  const seen = new Set<string>();
  const decisions: RemotePlanDecision[] = body.decisions.map((item) => {
    if (!item || typeof item !== "object") throw new Error("云端填写计划字段无效。");
    const row = item as Record<string, unknown>;
    const fieldId = text(row.fieldId, 128);
    const field = allowedFields.get(fieldId);
    if (!field || seen.has(fieldId)) throw new Error("云端填写计划含未知或重复字段。");
    seen.add(fieldId);
    if (!["fill", "manual", "skip"].includes(String(row.action)) || !Number.isFinite(row.confidence)
      || Number(row.confidence) < 0 || Number(row.confidence) > 1 || !isPlanValue(row.value)) {
      throw new Error("云端填写计划决策无效。");
    }
    if (row.action === "fill") {
      if (field.hidden || field.disabled || field.readOnly
        || (field.hasValue && (!expectedOverwriteExisting || !OVERWRITABLE_TEXT_CONTROLS.has(field.controlType)))) {
        throw new Error("云端填写计划包含不可覆盖的字段。");
      }
      const expectsArray = field.controlType === "multi_select" || field.controlType === "checkbox";
      if (expectsArray ? !Array.isArray(row.value) : typeof row.value !== "string") {
        throw new Error("云端填写计划值与控件不兼容。");
      }
      if (row.sensitivity === "restricted" || RESTRICTED_REMOTE_KEYS.has(String(row.canonicalKey))) {
        throw new Error("云端填写计划含受限字段。");
      }
      if (field.recordKind && !field.recordId) throw new Error("未绑定重复经历不可填写。");
    } else if (row.value !== null) {
      throw new Error("非填写决策不可携带值。");
    }
    return {
      fieldId,
      action: row.action as RemotePlanDecision["action"],
      canonicalKey: row.canonicalKey === null ? null : text(row.canonicalKey, 64),
      confidence: Number(row.confidence),
      reason: text(row.reason, 120),
      value: row.value as string | string[] | null,
      sensitivity: text(row.sensitivity, 40),
    };
  });
  const coverage = body.coverage as Record<string, unknown> | undefined;
  const requiredTotal = nonNegativeInteger(coverage?.requiredTotal);
  const requiredFillable = nonNegativeInteger(coverage?.requiredFillable);
  const requiredManual = nonNegativeInteger(coverage?.requiredManual);
  if (requiredTotal === null || requiredFillable === null || requiredManual === null
    || requiredFillable + requiredManual > requiredTotal) throw new Error("云端填写计划统计无效。");
  return {
    schemaVersion: 2, publishedRevision: expectedRevision, vendor: expectedVendor,
    overwriteExisting: expectedOverwriteExisting,
    autoSubmit: false, decisions,
    coverage: { requiredTotal, requiredFillable, requiredManual, complete: Boolean(coverage?.complete) },
  };
}

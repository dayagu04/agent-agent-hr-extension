import { repeatedProfileKey, resolveRepeatedValue } from "./repeat-context.ts";
import type { ProfileData, ProfileFieldKey, RepeatedFieldContext, StructuredEntryField } from "./types";

export type FieldControl =
  | "text" | "textarea" | "email" | "tel" | "url" | "date" | "month" | "number"
  | "select" | "radio" | "checkbox" | "combobox" | "file" | "contenteditable" | "hidden" | "unknown";

export interface FieldOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface FieldDescriptor {
  label?: string;
  labelSource?: "associated" | "wrapping" | "nearby" | "container" | "adapter" | "none";
  ariaLabel?: string;
  placeholder?: string;
  name?: string;
  autocomplete?: string;
  controlType: FieldControl;
  required?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  hasValue?: boolean;
  multiple?: boolean;
  options?: FieldOption[];
  repeated?: RepeatedFieldContext;
}

export interface FieldDecision {
  action: "fill" | "manual" | "skip";
  profileKey: ProfileFieldKey | null;
  confidence: number;
  reason: string;
  value: string | string[] | null;
  sourceValue?: string;
  entrySource?: RepeatedFieldContext;
}

export interface MatchOptions {
  allowExistingText?: boolean;
}

export interface RequiredCoverage {
  requiredTotal: number;
  requiredFillable: number;
  requiredManual: number;
  complete: boolean;
}

export function summarizeRequiredCoverage(items: Array<{ required?: boolean; decision: FieldDecision }>): RequiredCoverage {
  const visibleRequired = items.filter(({ required, decision }) => required && decision.action !== "skip");
  const requiredFillable = visibleRequired.filter(({ decision }) => decision.action === "fill").length;
  const requiredManual = visibleRequired.filter(({ decision }) => decision.action === "manual").length;
  return {
    requiredTotal: visibleRequired.length,
    requiredFillable,
    requiredManual,
    complete: requiredManual === 0,
  };
}

interface FieldSpec {
  key: ProfileFieldKey;
  aliases: string[];
  controls: Set<FieldControl>;
}

const TEXT = ["text", "textarea", "contenteditable"] as const;
const CHOICE = ["select", "radio"] as const;
const OVERWRITABLE_EXISTING_CONTROLS = new Set<FieldControl>(["text", "textarea", "email", "tel", "url", "date", "month", "number"]);

const SPECS: FieldSpec[] = [
  { key: "fullName", aliases: ["姓名", "中文姓名", "真实姓名", "全名", "name", "full name", "legal name", "candidate name"], controls: new Set(TEXT) },
  { key: "preferredName", aliases: ["常用称呼", "昵称", "preferred name", "nickname"], controls: new Set(TEXT) },
  { key: "phone", aliases: ["手机", "手机号", "手机号码", "联系电话", "电话号码", "mobile", "mobile phone", "phone", "phone number", "contact number", "telephone"], controls: new Set([...TEXT, "tel"]) },
  { key: "email", aliases: ["邮箱", "电子邮箱", "电子邮件", "联系邮箱", "email", "email address", "e-mail", "mail address"], controls: new Set([...TEXT, "email"]) },
  { key: "gender", aliases: ["性别", "gender", "sex"], controls: new Set([...TEXT, ...CHOICE]) },
  { key: "birthDate", aliases: ["出生日期", "出生年月", "生日", "date of birth", "birth date", "birthday", "dob"], controls: new Set([...TEXT, "date", "month"]) },
  { key: "preferredLocation", aliases: ["期望城市", "期望地点", "期望工作地", "意向城市", "意向地点", "preferred location", "preferred city"], controls: new Set([...TEXT, ...CHOICE]) },
  { key: "location", aliases: ["当前城市", "现居城市", "所在城市", "居住城市", "现居地", "current city", "city of residence", "current location"], controls: new Set([...TEXT, ...CHOICE]) },
  { key: "address", aliases: ["详细地址", "现居地址", "联系地址", "通讯地址", "居住地址", "current address", "contact address", "mailing address", "street address", "address"], controls: new Set(TEXT) },
  { key: "website", aliases: ["个人网站", "主页链接", "作品链接", "作品集", "portfolio", "portfolio url", "personal website", "homepage"], controls: new Set([...TEXT, "url"]) },
  { key: "github", aliases: ["github", "github url", "github profile", "代码仓库"], controls: new Set([...TEXT, "url"]) },
  { key: "school", aliases: ["学校", "学校名称", "院校", "毕业院校", "school", "university", "college", "institution"], controls: new Set([...TEXT, ...CHOICE]) },
  { key: "major", aliases: ["专业", "专业名称", "所学专业", "major", "field of study"], controls: new Set([...TEXT, ...CHOICE]) },
  { key: "degree", aliases: ["学历", "最高学历", "学位", "最高学位", "degree", "highest degree", "education level"], controls: new Set([...TEXT, ...CHOICE]) },
  { key: "gpa", aliases: ["gpa", "绩点", "成绩排名"], controls: new Set([...TEXT, "number"]) },
  { key: "educationStart", aliases: ["入学时间", "教育开始时间", "education start", "school start date"], controls: new Set([...TEXT, "date", "month"]) },
  { key: "educationEnd", aliases: ["毕业时间", "预计毕业", "教育结束时间", "graduation date", "education end"], controls: new Set([...TEXT, "date", "month"]) },
  { key: "projects", aliases: ["项目经历", "项目描述", "项目介绍", "project experience", "projects"], controls: new Set(TEXT) },
  { key: "awards", aliases: ["获奖经历", "奖项", "荣誉", "awards", "honors"], controls: new Set(TEXT) },
  { key: "experience", aliases: ["实习经历", "工作经历", "职责描述", "work experience", "employment history"], controls: new Set(TEXT) },
  { key: "skills", aliases: ["技能", "专业技能", "技能标签", "技术栈", "skills", "technical skills"], controls: new Set([...TEXT, "checkbox", "select"]) },
  { key: "summary", aliases: ["自我介绍", "个人优势", "自我评价", "个人总结", "summary", "about yourself"], controls: new Set(TEXT) },
];

const SPEC_BY_KEY = new Map(SPECS.map((spec) => [spec.key, spec]));
const MIN_CONFIDENCE = 0.8;
const MIN_MARGIN = 0.08;

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/^[*＊·•\s]+|[*＊·•\s]+$/g, "")
    .replace(/(?:\(必填\)|（必填）|必填|required)\s*$/i, "")
    .trim();
}

function compact(value: unknown): string {
  return normalizeText(value).replace(/[^0-9a-z\u3400-\u9fff]+/g, "");
}

function unsafeContext(value: string, key: ProfileFieldKey): boolean {
  const normalized = compact(value);
  if (/(验证码|动态码|captcha|verificationcode|password|密码)/i.test(normalized)) return true;
  if (["fullName", "phone", "email", "address"].includes(key) && /(紧急联系人|推荐人|证明人|监护人|emergencycontact|reference|referrer|guardian)/i.test(normalized)) return true;
  if (key === "fullName" && /(公司|企业|雇主|用户名|company|employer|username)/i.test(normalized)) return true;
  if (["phone", "email"].includes(key) && /(工作邮箱|公司邮箱|工作电话|workemail|businessemail|officephone)/i.test(normalized)) return true;
  if (key === "address" && /(邮箱|电子邮件|email|公司地址|单位地址|企业地址|办公地址|工作地址|公司所在地|单位所在地|companyaddress|employeraddress|businessaddress|officeaddress|workaddress)/i.test(normalized)) return true;
  return false;
}

function aliasScore(value: unknown, alias: string): number {
  const normalized = normalizeText(value);
  const normalizedAlias = normalizeText(alias);
  if (!normalized || !normalizedAlias) return 0;
  if (normalized === normalizedAlias || compact(normalized) === compact(normalizedAlias)) return 1;
  const candidate = compact(normalized);
  const target = compact(normalizedAlias);
  const minimum = /[\u3400-\u9fff]/.test(target) ? 2 : 5;
  return target.length >= minimum && candidate.includes(target) ? 0.86 : 0;
}

export function classifyDescriptor(descriptor: FieldDescriptor): Omit<FieldDecision, "action" | "value"> {
  const evidence: Array<[string, string | undefined, number]> = [
    ["label", descriptor.label, 1],
    ["ariaLabel", descriptor.ariaLabel, 0.96],
    ["placeholder", descriptor.placeholder, 0.88],
    ["name", descriptor.name, 0.84],
    ["autocomplete", descriptor.autocomplete, 0.88],
  ];
  const candidates = new Map<ProfileFieldKey, number>();
  const strongExact = new Set<ProfileFieldKey>();
  for (const [source, value, weight] of evidence) {
    if (!normalizeText(value)) continue;
    for (const spec of SPECS) {
      if (unsafeContext(value ?? "", spec.key)) continue;
      const bestAlias = Math.max(0, ...spec.aliases.map((alias) => aliasScore(value, alias)));
      if (!bestAlias) continue;
      const score = Number((bestAlias * weight).toFixed(4));
      candidates.set(spec.key, Math.max(candidates.get(spec.key) ?? 0, score));
      if (bestAlias === 1 && weight >= 0.88 && source !== "autocomplete") strongExact.add(spec.key);
    }
  }

  const typeHint: Partial<Record<FieldControl, ProfileFieldKey>> = { email: "email", tel: "phone" };
  const hintedKey = typeHint[descriptor.controlType];
  if (hintedKey) candidates.set(hintedKey, Math.max(candidates.get(hintedKey) ?? 0, 0.72));
  if (!candidates.size) return { profileKey: null, confidence: 0, reason: "unknown_semantics" };

  const ordered = [...candidates.entries()].sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey));
  const [bestKey, bestScore] = ordered[0];
  const runnerUp = ordered[1]?.[1] ?? 0;
  if (strongExact.size > 1 && runnerUp >= MIN_CONFIDENCE) return { profileKey: null, confidence: bestScore, reason: "ambiguous_semantics" };
  if (bestScore < MIN_CONFIDENCE) return { profileKey: null, confidence: bestScore, reason: "low_confidence" };
  if (runnerUp && bestScore - runnerUp < MIN_MARGIN) return { profileKey: null, confidence: bestScore, reason: "ambiguous_semantics" };
  return { profileKey: bestKey, confidence: bestScore, reason: "matched" };
}

/**
 * Resolves only the semantic owner of a field.  Eligibility state (including
 * an existing value, disabled, or readonly state) is intentionally ignored so
 * non-fillable controls can still guard against an unsafe scalar duplicate.
 */
export function semanticProfileKey(descriptor: FieldDescriptor, explicitKey?: ProfileFieldKey): ProfileFieldKey | null {
  if (descriptor.repeated) return repeatedProfileKey(descriptor.repeated);
  if (explicitKey) return explicitKey;
  return classifyDescriptor(descriptor).profileKey;
}

const CHOICE_SYNONYMS = [
  ["男", "male", "m", "man"],
  ["女", "female", "f", "woman"],
  ["本科", "学士", "bachelor", "bachelors", "bachelor degree"],
  ["硕士", "研究生", "master", "masters", "master degree"],
  ["博士", "phd", "doctorate", "doctoral"],
].map((items) => new Set(items.map(normalizeText)));

function choiceTokens(value: unknown): Set<string> {
  const normalized = normalizeText(value);
  return CHOICE_SYNONYMS.find((aliases) => aliases.has(normalized)) ?? new Set([normalized]);
}

function matchChoice(value: string, options: FieldOption[]): { value: string | null; reason: string } {
  const sourceTokens = choiceTokens(value);
  const writableOptions = options.filter((option) => !option.disabled);
  const matches = writableOptions.filter((option) => {
    const optionTokens = choiceTokens(option.label || option.value);
    return [...sourceTokens].some((token) => optionTokens.has(token));
  });
  if (matches.length > 1) return { value: null, reason: "ambiguous_choice" };
  if (matches.length === 1) {
    const [match] = matches;
    const valueOwners = writableOptions.filter((option) => option.value === match.value);
    if (valueOwners.length !== 1) return { value: null, reason: "ambiguous_choice" };
    return { value: match.value, reason: "choice_matched" };
  }
  return { value: null, reason: "choice_not_found" };
}

function splitMulti(value: string): string[] {
  return value.split(/[,，、;；\n]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeDate(value: string, control: FieldControl): { value: string | null; reason: string } {
  const parts = normalizeText(value)
    .replace(/日$/u, "")
    .replace(/[年月/.]/gu, "-")
    .replace(/-+$/u, "")
    .split("-")
    .map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return { value: null, reason: "invalid_date" };
  }
  if (control === "date" && parts.length !== 3) {
    return { value: null, reason: "date_precision_insufficient" };
  }
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2] ?? 1);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { value: null, reason: "invalid_date" };
  }
  const monthText = String(month).padStart(2, "0");
  if (control === "month") return { value: `${year}-${monthText}`, reason: "date_normalized" };
  return { value: `${year}-${monthText}-${String(day).padStart(2, "0")}`, reason: "date_normalized" };
}

function prepareValue(spec: FieldSpec, value: string, descriptor: FieldDescriptor): { value: string | string[] | null; reason: string } {
  if (!spec.controls.has(descriptor.controlType)) return { value: null, reason: "unsupported_control" };
  if (["date", "month"].includes(descriptor.controlType)) {
    return normalizeDate(value, descriptor.controlType);
  }
  const options = descriptor.options ?? [];
  if (descriptor.controlType === "select" || descriptor.controlType === "radio") {
    if (descriptor.multiple) {
      const selected: string[] = [];
      for (const item of splitMulti(value)) {
        const match = matchChoice(item, options);
        if (!match.value) {
          return { value: null, reason: match.reason === "ambiguous_choice" ? "ambiguous_choice" : "partial_multi_choice" };
        }
        if (selected.includes(match.value)) return { value: null, reason: "ambiguous_choice" };
        selected.push(match.value);
      }
      return selected.length ? { value: selected, reason: "choices_matched" } : { value: null, reason: "choice_not_found" };
    }
    return matchChoice(value, options);
  }
  if (descriptor.controlType === "checkbox") {
    const selected: string[] = [];
    for (const item of splitMulti(value)) {
      const match = matchChoice(item, options);
      if (!match.value) {
        return { value: null, reason: match.reason === "ambiguous_choice" ? "ambiguous_choice" : "partial_multi_choice" };
      }
      if (selected.includes(match.value)) return { value: null, reason: "ambiguous_choice" };
      selected.push(match.value);
    }
    return selected.length ? { value: selected, reason: "choices_matched" } : { value: null, reason: "choice_not_found" };
  }
  return value.trim() ? { value: value.trim(), reason: "value_ready" } : { value: null, reason: "missing_profile_value" };
}

export function isAiPolishAllowed(descriptor: FieldDescriptor, profileKey: ProfileFieldKey): boolean {
  if (descriptor.repeated) return descriptor.repeated.field === "description";
  return ["summary", "experience", "projects"].includes(profileKey);
}

const REPEATED_FIELD_CONTROLS: Record<StructuredEntryField, Set<FieldControl>> = {
  organization: new Set(TEXT),
  role: new Set(TEXT),
  name: new Set(TEXT),
  school: new Set([...TEXT, ...CHOICE]),
  major: new Set([...TEXT, ...CHOICE]),
  degree: new Set([...TEXT, ...CHOICE]),
  gpa: new Set([...TEXT, "number"]),
  startDate: new Set([...TEXT, "date", "month"]),
  endDate: new Set([...TEXT, "date", "month"]),
  date: new Set([...TEXT, "date", "month"]),
  location: new Set([...TEXT, ...CHOICE]),
  link: new Set([...TEXT, "url"]),
  description: new Set(TEXT),
};

function matchRepeatedDescriptor(descriptor: FieldDescriptor, profile: ProfileData): FieldDecision {
  const context = descriptor.repeated!;
  const profileKey = repeatedProfileKey(context);
  if (!profileKey) {
    return { action: "manual", profileKey: null, confidence: 1, reason: "unsupported_repeated_field", value: null, entrySource: context };
  }
  const resolved = resolveRepeatedValue(profile, context);
  if (resolved.value === null) {
    return { action: "manual", profileKey, confidence: 1, reason: resolved.reason, value: null, entrySource: context };
  }
  if (!resolved.value) {
    return { action: "manual", profileKey, confidence: 1, reason: "missing_profile_value", value: null, entrySource: context };
  }
  const prepared = prepareValue(
    { key: profileKey, aliases: [], controls: REPEATED_FIELD_CONTROLS[context.field] },
    resolved.value,
    descriptor,
  );
  return {
    action: prepared.value === null ? "manual" : "fill",
    profileKey,
    confidence: 1,
    reason: prepared.reason === "value_ready" ? "record_value_ready" : prepared.reason,
    value: prepared.value,
    sourceValue: resolved.value,
    entrySource: context,
  };
}

export function matchDescriptor(
  descriptor: FieldDescriptor,
  profile: ProfileData,
  explicitKey?: ProfileFieldKey,
  options: MatchOptions = {},
): FieldDecision {
  if (descriptor.hidden || descriptor.controlType === "hidden") return { action: "skip", profileKey: null, confidence: 1, reason: "hidden_field", value: null };
  if (descriptor.disabled) return { action: "skip", profileKey: null, confidence: 1, reason: "disabled_field", value: null };
  if (descriptor.readOnly) return { action: "skip", profileKey: null, confidence: 1, reason: "readonly_field", value: null };
  const overwritableExisting = descriptor.hasValue && options.allowExistingText === true
    && OVERWRITABLE_EXISTING_CONTROLS.has(descriptor.controlType);
  if (descriptor.hasValue && !overwritableExisting) {
    return { action: "skip", profileKey: null, confidence: 1, reason: "already_filled", value: null };
  }
  if (descriptor.controlType === "file") {
    return { action: "manual", profileKey: null, confidence: 1, reason: "attachment_user_required", value: null };
  }
  if (descriptor.controlType === "combobox") {
    const classification = classifyDescriptor(descriptor);
    return { action: "manual", ...classification, reason: "dynamic_choice_requires_user_action", value: null };
  }
  if (descriptor.repeated) return matchRepeatedDescriptor(descriptor, profile);

  const classification = explicitKey
    ? { profileKey: explicitKey, confidence: 0.99, reason: "user_mapping" }
    : classifyDescriptor(descriptor);
  if (!classification.profileKey) return { action: "manual", ...classification, value: null };
  const value = profile[classification.profileKey];
  if (typeof value !== "string" || !value.trim()) {
    return { action: "manual", ...classification, reason: "missing_profile_value", value: null };
  }
  const spec = SPEC_BY_KEY.get(classification.profileKey);
  if (!spec) return { action: "manual", ...classification, reason: "unsupported_profile_key", value: null };
  const prepared = prepareValue(spec, value, descriptor);
  return {
    action: prepared.value === null ? "manual" : "fill",
    profileKey: classification.profileKey,
    confidence: classification.confidence,
    reason: prepared.reason,
    value: prepared.value,
    ...(prepared.value === null ? {} : { sourceValue: value.trim() }),
  };
}

import type {
  AwardEntry,
  EducationEntry,
  ExperienceEntry,
  ProfileData,
  ProfileFieldKey,
  ProjectEntry,
  RepeatedFieldContext,
  StructuredEntryField,
  StructuredEntryKind,
} from "./types";

export interface StructuredEntryOption {
  id: string;
  label: string;
}

type StructuredEntry = EducationEntry | ExperienceEntry | ProjectEntry | AwardEntry;

const KIND_PATTERNS: Array<[StructuredEntryKind, RegExp]> = [
  ["education", /(教育经历|教育背景|学历信息|education|academic|school)/i],
  ["experience", /(工作经历|实习经历|任职经历|职业经历|employment|work[\s_-]*experience|internship|career)/i],
  ["project", /(项目经历|项目经验|project[\s_-]*(?:experience|history)?)/i],
  ["award", /(获奖经历|荣誉奖项|奖项|award|honou?r)/i],
];

const FIELD_PATTERNS: Record<StructuredEntryKind, Array<[StructuredEntryField, RegExp]>> = {
  education: [
    ["school", /^(学校|学校名称|院校|院校名称|毕业院校|school|university|college|institution)$/i],
    ["major", /^(专业|专业名称|所学专业|major|field of study)$/i],
    ["degree", /^(学历|学位|学历层次|degree|education level)$/i],
    ["gpa", /^(gpa|绩点|成绩排名)$/i],
    ["startDate", /^(入学时间|开始时间|起始时间|start date|from)$/i],
    ["endDate", /^(毕业时间|结束时间|截止时间|end date|to)$/i],
    ["description", /^(补充说明|教育描述|description)$/i],
  ],
  experience: [
    ["organization", /^(公司|公司名称|单位|单位名称|工作单位|雇主|employer|company|organization)$/i],
    ["role", /^(职位|职位名称|岗位|岗位名称|职务|job title|position|role)$/i],
    ["startDate", /^(开始时间|入职时间|起始时间|start date|from)$/i],
    ["endDate", /^(结束时间|离职时间|截止时间|end date|to)$/i],
    ["location", /^(工作地点|地点|城市|location|city)$/i],
    ["description", /^(工作内容|职责描述|工作描述|主要职责|description|responsibilities)$/i],
  ],
  project: [
    ["name", /^(项目名称|项目|project name|project)$/i],
    ["role", /^(项目角色|担任角色|负责内容|role)$/i],
    ["startDate", /^(开始时间|起始时间|start date|from)$/i],
    ["endDate", /^(结束时间|截止时间|end date|to)$/i],
    ["link", /^(项目链接|链接|project url|project link)$/i],
    ["description", /^(项目描述|项目内容|description)$/i],
  ],
  award: [
    ["name", /^(奖项名称|奖项|荣誉名称|award name|award)$/i],
    ["organization", /^(颁发组织|颁发单位|授予机构|issuer|organization)$/i],
    ["date", /^(获奖时间|颁发时间|日期|award date|date)$/i],
    ["description", /^(补充说明|奖项描述|description)$/i],
  ],
};

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[：:*＊]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function inferStructuredEntryKind(context: string): StructuredEntryKind | null {
  const normalized = normalize(context);
  return KIND_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

export function inferStructuredEntryField(kind: StructuredEntryKind, label: string): StructuredEntryField | null {
  const normalized = normalize(label);
  if (!normalized) return null;
  const fragments = normalized.split(/\s*[|｜]\s*/).filter(Boolean);
  for (const fragment of fragments.length ? fragments : [normalized]) {
    const match = FIELD_PATTERNS[kind].find(([, pattern]) => pattern.test(fragment));
    if (match) return match[0];
  }
  return null;
}

export function structuredEntries(profile: ProfileData, kind: StructuredEntryKind): StructuredEntry[] {
  if (kind === "education") return profile.educationEntries;
  if (kind === "experience") return profile.experienceEntries;
  if (kind === "project") return profile.projectEntries;
  return profile.awardEntries;
}

function compactLabel(parts: string[]): string {
  const label = parts.map((part) => normalize(part)).filter(Boolean).slice(0, 2).join(" · ");
  return label.slice(0, 72) || "未命名记录";
}

export function structuredEntryOptions(profile: ProfileData, kind: StructuredEntryKind): StructuredEntryOption[] {
  return structuredEntries(profile, kind).map((entry, index) => {
    let label = "";
    if (kind === "education") {
      const item = entry as EducationEntry;
      label = compactLabel([item.school, item.major || item.degree]);
    } else if (kind === "experience") {
      const item = entry as ExperienceEntry;
      label = compactLabel([item.organization, item.role]);
    } else if (kind === "project") {
      const item = entry as ProjectEntry;
      label = compactLabel([item.name, item.role]);
    } else {
      const item = entry as AwardEntry;
      label = compactLabel([item.name, item.organization]);
    }
    return { id: entry.id, label: `第 ${index + 1} 条 · ${label}` };
  });
}

export function repeatedProfileKey(context: RepeatedFieldContext): ProfileFieldKey | null {
  if (context.kind === "experience") return "experience";
  if (context.kind === "project") return "projects";
  if (context.kind === "award") return "awards";
  const keys: Partial<Record<StructuredEntryField, ProfileFieldKey>> = {
    school: "school",
    major: "major",
    degree: "degree",
    gpa: "gpa",
    startDate: "educationStart",
    endDate: "educationEnd",
  };
  return keys[context.field] ?? null;
}

export function resolveRepeatedValue(
  profile: ProfileData,
  context: RepeatedFieldContext,
): { value: string | null; reason: "record_value_ready" | "repeated_group_unbound" | "repeated_group_target_missing" | "unsupported_repeated_field" } {
  if (!context.targetEntryId) return { value: null, reason: "repeated_group_unbound" };
  const entry = structuredEntries(profile, context.kind).find((candidate) => candidate.id === context.targetEntryId);
  if (!entry) return { value: null, reason: "repeated_group_target_missing" };
  if (!(context.field in entry)) return { value: null, reason: "unsupported_repeated_field" };
  const value = entry[context.field as keyof StructuredEntry];
  return typeof value === "string" && value.trim()
    ? { value: value.trim(), reason: "record_value_ready" }
    : { value: "", reason: "record_value_ready" };
}

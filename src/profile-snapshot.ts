import type { RemoteProfileStatus } from "./remote-autofill.ts";
import { buildResumeSections } from "./resume-data.ts";
import { EMPTY_PROFILE, type AwardEntry, type EducationEntry, type ExperienceEntry, type ProfileData, type ProjectEntry } from "./types.ts";

export interface CachedProfileSnapshot extends RemoteProfileStatus {
  schemaVersion: 1;
  account: { userId: number; displayName: string };
  profile: ProfileData;
}

type JsonRecord = Record<string, unknown>;

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效。`);
  return value as JsonRecord;
}

function text(record: JsonRecord, key: string, limit = 4_000): string {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > limit) throw new Error("网申资料字段格式无效。");
  return value.trim();
}

function rows(profile: JsonRecord, section: string): JsonRecord[] {
  const value = profile[section];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("网申资料记录格式无效。");
  return value.map((item) => {
    const record = object(item, "网申资料记录");
    const recordId = text(record, "recordId", 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(recordId)) throw new Error("网申资料记录标识无效。");
    return record;
  });
}

function joined(...values: string[]): string {
  return values.filter(Boolean).join("\n").slice(0, 4_000);
}

function options<T extends { id: string }>(entries: T[], label: (entry: T) => string) {
  return entries.map((entry, index) => ({
    recordId: entry.id,
    label: (label(entry).trim() || `记录 ${index + 1}`).slice(0, 120),
  }));
}

export function normalizeProfileSnapshot(raw: unknown): CachedProfileSnapshot {
  const body = object(raw, "网申资料快照");
  if (body.schemaVersion !== 1) throw new Error("网申资料快照版本不兼容。");
  const account = object(body.account, "网申账号");
  if (!Number.isInteger(account.userId) || Number(account.userId) < 1 || typeof account.displayName !== "string") {
    throw new Error("网申账号格式无效。");
  }
  const draftRevision = Number(body.draftRevision);
  const publishedRevision = Number(body.publishedRevision);
  if (!Number.isInteger(draftRevision) || draftRevision < 0 || !Number.isInteger(publishedRevision) || publishedRevision < 0
    || !["active", "empty"].includes(String(body.publishedStatus))) {
    throw new Error("网申资料快照状态无效。");
  }
  const rawProfile = object(body.profile, "网申资料");
  const basic = object(rawProfile.basic ?? {}, "个人信息");
  const educations = rows(rawProfile, "educations");
  const employments = rows(rawProfile, "employments");
  const practices = rows(rawProfile, "practices");
  const projects = rows(rawProfile, "projects");
  const awards = rows(rawProfile, "awards");
  const skills = rows(rawProfile, "skills");
  const links = rows(rawProfile, "links");

  const educationEntries: EducationEntry[] = educations.map((record) => ({
    id: text(record, "recordId", 64), school: text(record, "school_name"), major: text(record, "major"),
    degree: text(record, "education_level") || text(record, "degree"), startDate: text(record, "start_month"),
    endDate: text(record, "end_month"), gpa: text(record, "gpa_value"),
    description: joined(text(record, "education_description"), text(record, "course_summary")),
  }));
  const employmentEntries: ExperienceEntry[] = employments.map((record) => ({
    id: text(record, "recordId", 64), organization: text(record, "employer_name"), role: text(record, "job_title"),
    startDate: text(record, "start_month"), endDate: text(record, "end_month"), location: text(record, "location"),
    description: joined(text(record, "responsibilities"), text(record, "achievements")),
  }));
  const practiceEntries: ExperienceEntry[] = practices.map((record) => ({
    id: text(record, "recordId", 64), organization: text(record, "organization_name"),
    role: text(record, "role_title") || text(record, "program_name"), startDate: text(record, "start_date"),
    endDate: text(record, "end_date"), location: text(record, "location"),
    description: joined(text(record, "tasks"), text(record, "contributions"), text(record, "outcomes")),
  }));
  const projectEntries: ProjectEntry[] = projects.map((record) => ({
    id: text(record, "recordId", 64), name: text(record, "name"), role: text(record, "role_title"),
    startDate: text(record, "start_month"), endDate: text(record, "end_month"),
    link: text(record, "project_url") || text(record, "repository_url") || text(record, "demo_url"),
    description: joined(text(record, "responsibilities"), text(record, "results")),
  }));
  const awardEntries: AwardEntry[] = awards.map((record) => ({
    id: text(record, "recordId", 64), name: text(record, "name"), organization: text(record, "issuer"),
    date: text(record, "date"), description: text(record, "description"),
  }));
  const firstEducation = educationEntries.length === 1 ? educationEntries[0] : null;
  const firstGithub = links.find((record) => /github/i.test(text(record, "platform")));
  const firstWebsite = links.find((record) => !/github/i.test(text(record, "platform")));
  const profile: ProfileData = {
    ...EMPTY_PROFILE,
    resumeSections: buildResumeSections(rawProfile),
    fullName: text(basic, "legal_name_zh"), preferredName: text(basic, "preferred_name"),
    phone: text(basic, "mobile_number"), email: text(basic, "contact_email"), gender: text(basic, "gender"),
    birthDate: text(basic, "birth_date"), location: text(basic, "residence_city"),
    address: text(basic, "contact_address"), summary: text(basic, "personal_summary"),
    website: firstWebsite ? text(firstWebsite, "url") : "", github: firstGithub ? text(firstGithub, "url") : "",
    school: firstEducation?.school ?? "", major: firstEducation?.major ?? "", degree: firstEducation?.degree ?? "",
    gpa: firstEducation?.gpa ?? "", educationStart: firstEducation?.startDate ?? "", educationEnd: firstEducation?.endDate ?? "",
    skills: [...new Set(skills.map((record) => text(record, "name")).filter(Boolean))].join("、").slice(0, 4_000),
    experienceEntries: [...employmentEntries, ...practiceEntries], educationEntries, projectEntries, awardEntries,
  };
  const recordOptions: RemoteProfileStatus["recordOptions"] = {
    education: options(educationEntries, (entry) => [entry.school, entry.major || entry.degree].filter(Boolean).join(" · ")),
    employment: options(profile.experienceEntries, (entry) => [entry.organization, entry.role].filter(Boolean).join(" · ")),
    project: options(projectEntries, (entry) => [entry.name, entry.role].filter(Boolean).join(" · ")),
    award: options(awardEntries, (entry) => [entry.name, entry.organization].filter(Boolean).join(" · ")),
  };
  return {
    schemaVersion: 1,
    account: { userId: Number(account.userId), displayName: account.displayName.slice(0, 120) || "谷谷用户" },
    draftRevision, publishedRevision,
    publishedStatus: body.publishedStatus as CachedProfileSnapshot["publishedStatus"],
    hasPendingImport: body.hasPendingImport === true,
    hasUnpublishedDraft: body.hasUnpublishedDraft === true,
    recordOptions,
    profile,
  };
}

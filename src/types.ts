export type ProfileFieldKey =
  | "fullName"
  | "preferredName"
  | "phone"
  | "email"
  | "gender"
  | "birthDate"
  | "location"
  | "address"
  | "preferredLocation"
  | "website"
  | "github"
  | "school"
  | "major"
  | "degree"
  | "gpa"
  | "educationStart"
  | "educationEnd"
  | "summary"
  | "skills"
  | "experience"
  | "projects"
  | "awards";

export interface ExperienceEntry {
  id: string;
  organization: string;
  role: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
}

export interface ProjectEntry {
  id: string;
  name: string;
  role: string;
  startDate: string;
  endDate: string;
  link: string;
  description: string;
}

export interface EducationEntry {
  id: string;
  school: string;
  major: string;
  degree: string;
  startDate: string;
  endDate: string;
  gpa: string;
  description: string;
}

export interface AwardEntry {
  id: string;
  name: string;
  organization: string;
  date: string;
  description: string;
}

export type StructuredEntryKind = "education" | "experience" | "project" | "award";

export type StructuredEntryField =
  | "organization"
  | "role"
  | "name"
  | "school"
  | "major"
  | "degree"
  | "gpa"
  | "startDate"
  | "endDate"
  | "date"
  | "location"
  | "link"
  | "description";

export interface RepeatedFieldContext {
  groupKey: string;
  groupLabel: string;
  kind: StructuredEntryKind;
  field: StructuredEntryField;
  targetEntryId?: string;
}

export type ProfileData = Record<ProfileFieldKey, string> & {
  resumeSections?: import("./resume-data").ResumeSection[];
  resumeRawText: string;
  experienceEntries: ExperienceEntry[];
  projectEntries: ProjectEntry[];
  educationEntries: EducationEntry[];
  awardEntries: AwardEntry[];
};

export interface AiSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  rememberKey: boolean;
  instructions: string;
}

export interface StoredState {
  schemaVersion: 1;
  profile: ProfileData;
  ai: AiSettings;
  apiKey?: string;
}

export interface FieldMatch {
  id: string;
  key?: ProfileFieldKey;
  source?: "local" | "remote";
  canonicalKey?: string;
  sensitivity?: string;
  label: string;
  value: string;
  resolvedValue: string | string[];
  confidence: number;
  kind: "input" | "textarea" | "select" | "radio" | "checkbox" | "contenteditable";
  suggestedValue?: string;
  factWarnings?: string[];
  mappingLocked?: boolean;
  recordLabel?: string;
  aiPolishable?: boolean;
}

export interface PolishRequest {
  sourceText: string;
  question: string;
  companyContext: string;
}

export const PROFILE_FIELD_KEYS: ProfileFieldKey[] = [
  "fullName", "preferredName", "phone", "email", "gender", "birthDate", "location",
  "address", "preferredLocation", "website", "github", "school", "major", "degree", "gpa",
  "educationStart", "educationEnd", "summary", "skills", "experience", "projects", "awards",
];

export const EMPTY_PROFILE: ProfileData = Object.fromEntries(
  [...PROFILE_FIELD_KEYS, "resumeRawText"].map((key) => [key, ""]),
) as unknown as ProfileData;

EMPTY_PROFILE.experienceEntries = [];
EMPTY_PROFILE.projectEntries = [];
EMPTY_PROFILE.educationEntries = [];
EMPTY_PROFILE.awardEntries = [];

export const DEFAULT_STATE: StoredState = {
  schemaVersion: 1,
  profile: { ...EMPTY_PROFILE },
  ai: {
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "",
    rememberKey: false,
    instructions: "根据企业和岗位语境调整表达，突出与岗位相关的真实能力；不得虚构经历、职责、奖项、日期或数字。",
  },
};

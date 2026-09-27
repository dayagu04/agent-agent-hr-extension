export type ProfileFieldKey =
  | "fullName"
  | "preferredName"
  | "phone"
  | "email"
  | "gender"
  | "birthDate"
  | "location"
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

export type ProfileData = Record<ProfileFieldKey, string> & {
  resumeRawText: string;
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
  key: ProfileFieldKey;
  label: string;
  value: string;
  confidence: number;
  kind: "input" | "textarea" | "select" | "contenteditable";
}

export interface PolishRequest {
  sourceText: string;
  question: string;
  companyContext: string;
}

export const PROFILE_FIELD_KEYS: ProfileFieldKey[] = [
  "fullName", "preferredName", "phone", "email", "gender", "birthDate", "location",
  "preferredLocation", "website", "github", "school", "major", "degree", "gpa",
  "educationStart", "educationEnd", "summary", "skills", "experience", "projects", "awards",
];

export const EMPTY_PROFILE: ProfileData = Object.fromEntries(
  [...PROFILE_FIELD_KEYS, "resumeRawText"].map((key) => [key, ""]),
) as unknown as ProfileData;

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


import { semanticProfileKey, type FieldDescriptor } from "./field-matcher.ts";
import type { ProfileFieldKey } from "./types.ts";

/** Convert one hint to a closed-set profile key without a control-type guess. */
export function signalProfileKey(value?: string): ProfileFieldKey | null {
  return value ? semanticProfileKey({ label: value, controlType: "text" }) : null;
}

/** Only known server keys participate; an unknown key is never guessed. */
export function canonicalProfileKey(value?: string | null): ProfileFieldKey | null {
  if (!value) return null;
  const direct = new Set<ProfileFieldKey>([
    "fullName", "preferredName", "phone", "email", "gender", "birthDate", "location", "address",
    "preferredLocation", "website", "github", "school", "major", "degree", "gpa", "educationStart",
    "educationEnd", "summary", "skills", "experience", "projects", "awards",
  ]);
  if (direct.has(value as ProfileFieldKey)) return value as ProfileFieldKey;
  const normalized = value.toLowerCase().replace(/[.]/g, "_");
  const aliases: Record<string, ProfileFieldKey> = {
    full_name: "fullName", preferred_name: "preferredName", phone: "phone", mobile: "phone",
    mobile_phone: "phone", email: "email", gender: "gender", birth_date: "birthDate",
    location: "location", address: "address", preferred_location: "preferredLocation",
    website: "website", github: "github", school: "school", university: "school",
    major: "major", degree: "degree", gpa: "gpa", education_start: "educationStart",
    education_end: "educationEnd", summary: "summary", skills: "skills",
  };
  if (aliases[normalized]) return aliases[normalized];
  for (const [alias, key] of Object.entries(aliases)) {
    if (normalized.endsWith(`_${alias}`)) return key;
  }
  return null;
}

/** Conflicting visible hints are a field-mapping failure, not a write candidate. */
export function hasSemanticConflict(descriptor: FieldDescriptor, canonicalKey?: string | null): boolean {
  const hints = [descriptor.label, descriptor.ariaLabel, descriptor.placeholder, descriptor.name]
    .map(signalProfileKey).filter((key): key is ProfileFieldKey => key !== null);
  if (new Set(hints).size > 1) return true;
  const serverKey = canonicalProfileKey(canonicalKey);
  return Boolean(serverKey && hints.length && hints.some((key) => key !== serverKey));
}

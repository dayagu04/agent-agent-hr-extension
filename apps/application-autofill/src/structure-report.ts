/** User-copied, ephemeral DOM-shape report. Every printable token is closed-set. */
import { DIAGNOSTIC_VENDORS } from "./diagnostics.ts";

export const STRUCTURE_OUTCOMES = ["none", "retained", "cleared", "restored", "reverted", "stale"] as const;
export type StructureOutcome = typeof STRUCTURE_OUTCOMES[number];

const TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "DIV", "SPAN", "LABEL", "FORM", "LI", "TD", "TR", "SECTION", "FIELDSET"]);
const INPUT_TYPES = new Set(["text", "email", "tel", "url", "date", "month", "number", "radio", "checkbox", "select", "textarea", "combobox", "contenteditable"]);
const LABEL_SOURCES = new Set(["associated", "wrapping", "nearby", "container", "adapter", "none"]);
const SEMANTICS = new Set([
  "fullName", "preferredName", "phone", "email", "gender", "birthDate", "location", "address",
  "preferredLocation", "website", "github", "school", "major", "degree", "gpa", "educationStart",
  "educationEnd", "summary", "skills", "experience", "projects", "awards",
]);
const OUTCOMES = new Set<string>(STRUCTURE_OUTCOMES);

export interface StructureRow {
  document: number;
  tag: string;
  inputType: string;
  parent: string;
  siblingPosition: string;
  parentControls: number;
  labelSource: string;
  semantic: string;
  labelSemantic?: string;
  ariaSemantic?: string;
  placeholderSemantic?: string;
  nameSemantic?: string;
  planSemantic?: string;
  matched: boolean;
  outcome: string;
  resumeField?: string;
  resumeSection?: string;
  result?: string;
}

function token(value: string, allowed: Set<string>, fallback = "other"): string {
  return allowed.has(value) ? value : fallback;
}

function bounded(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 9_999) : 0;
}

export function formatStructureReport(vendor: string, documents: number, controls: number, rows: StructureRow[]): string {
  const safeVendor = DIAGNOSTIC_VENDORS.includes(vendor as typeof DIAGNOSTIC_VENDORS[number]) ? vendor : "generic";
  const safeRows = rows.slice(0, 80);
  return [
    `structure_v1 vendor=${safeVendor} documents=${bounded(documents)} controls=${bounded(controls)} shown=${safeRows.length} omitted=${bounded(rows.length - safeRows.length)}`,
    ...safeRows.map((row, index) => [
      `#${index + 1}`,
      `doc=${bounded(row.document)}`,
      `tag=${token(row.tag, TAGS)}`,
      `type=${token(row.inputType, INPUT_TYPES)}`,
      `parent=${token(row.parent, TAGS)}`,
      `position=${token(row.siblingPosition, new Set(["only", "first", "middle", "last"]))}`,
      `nearbyControls=${bounded(row.parentControls)}`,
      `labelSource=${token(row.labelSource, LABEL_SOURCES)}`,
      `semantic=${token(row.semantic, SEMANTICS, "unknown")}`,
      `label=${token(row.labelSemantic ?? "unknown", SEMANTICS, "unknown")}`,
      `aria=${token(row.ariaSemantic ?? "unknown", SEMANTICS, "unknown")}`,
      `placeholder=${token(row.placeholderSemantic ?? "unknown", SEMANTICS, "unknown")}`,
      `name=${token(row.nameSemantic ?? "unknown", SEMANTICS, "unknown")}`,
      `plan=${token(row.planSemantic ?? "unknown", SEMANTICS, "unknown")}`,
      `planned=${row.matched === true ? "yes" : "no"}`,
      `write=${token(row.outcome, OUTCOMES)}`,
      `section=${token(row.resumeSection ?? "", new Set(["basic", "educations", "internships", "work", "experience", "projects", "campus", "practices", "skills", "awards", "certificates", "languages", "links"]), "unknown")}`,
      `field=${token(row.resumeField ?? "", new Set(["name", "phone", "email", "gender", "birth_date", "residence_country", "residence_province", "residence_city", "nationality", "ethnicity", "native_place", "political_status", "hukou_location", "contact_address", "personal_summary", "school", "college", "major", "degree", "academic_degree", "start", "end", "gpa", "rank", "is_full_time", "description", "company", "role", "department", "location", "url", "date", "level", "score", "exam_name", "proficiency", "platform"]), "unknown")}`,
      `result=${token(row.result ?? "", new Set(["filled", "missing", "unknown", "unsupported", "failed"]), "none")}`,
    ].join(" ")),
  ].join("\n");
}

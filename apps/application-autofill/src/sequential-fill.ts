import { collectCandidates, collectScanDocuments, describeField, isDynamicChoiceElement, isEffectivelyDisabled, isElementVisible, isInputElement, isSemanticInventoryCandidate, optionLabel, scopeNamedChoiceGroup, writeAndVerifyTarget, type ElementSnapshot, type FillableElement, type FillTarget } from "./dom-safety.ts";
import type { FieldDescriptor } from "./field-matcher.ts";
import { fieldKey, highestEducation, normalizedLabel, sectionKey, sectionRecords, type ResumeSection } from "./resume-data.ts";
import { isIgnoredByAdapter, staticLabelTextOutsideControls, type SiteAdapter } from "./site-adapters.ts";
import type { StructureOutcome } from "./structure-report.ts";

export interface FillProgress { visited: number; filled: number; failed: number; skipped: number; current: string; stopped: boolean }
export interface FieldResult { element: FillableElement; field?: string; section?: string; outcome: StructureOutcome; reason: "filled" | "missing" | "unknown" | "unsupported" | "failed" }
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SENSITIVE = /密码|验证码|动态码|身份证|证件|护照|银行卡|支付|薪资|期望薪|推荐码|推荐人|证明人|紧急联系人|监护人|同意|协议|承诺|password|captcha|verification|passport|payment|salary|referrer|emergency|guardian|consent|agree|terms/i;

export function resolveResumeValue(sections: ResumeSection[], descriptor: FieldDescriptor, section = "basic", index = 0): { field: string; section: string; value: string } | null {
  const hints = [descriptor.label, descriptor.ariaLabel, descriptor.placeholder, descriptor.autocomplete, descriptor.name].filter(Boolean) as string[];
  if (hints.some((hint) => SENSITIVE.test(hint))) return null;
  const contactHints = new Set(hints.map((hint) => fieldKey("basic", hint)).filter((key) => key === "phone" || key === "email"));
  if (contactHints.size > 1 || descriptor.controlType === "email" && contactHints.has("phone")
    || descriptor.controlType === "tel" && contactHints.has("email")) return null;
  for (const hint of hints) {
    if (/^(最高学历院校|最高学历学校)$/.test(hint.trim())) {
      return { field: "school", section: "educations", value: highestEducation(sections)?.fields.find((item) => item.key === "school")?.value ?? "" };
    }
    if (/^(最高学历|最高学位|highest degree|highest education)$/i.test(hint.trim())) {
      const field = /学位/.test(hint) ? "academic_degree" : "degree";
      return { field, section: "educations", value: highestEducation(sections)?.fields.find((item) => item.key === field)?.value ?? "" };
    }
    const key = fieldKey(section, hint);
    if (key) return { field: key, section, value: section === "skills" && descriptor.controlType === "textarea"
      ? sectionRecords(sections, section).map((record) => record.fields.find((item) => item.key === key)?.value).filter(Boolean).join("、")
      : sectionRecords(sections, section)[index]?.fields.find((item) => item.key === key)?.value ?? "" };
    // Unmistakable labels work even when a site has no section headings.
    for (const family of ["basic", "educations", "projects", "skills", "links"]) {
      if (family !== "basic" && !/学校|学院|专业|学历|学位|绩点|项目名称|项目描述|专业技能|个人网站|github|school|university|major|gpa|project name/i.test(hint)) continue;
      const candidate = fieldKey(family, hint);
      if (!candidate) continue;
      const records = sectionRecords(sections, family);
      const value = family === "skills" ? records.map((record) => record.fields.find((item) => item.key === candidate)?.value).filter(Boolean).join("、")
        : records[family === section ? index : 0]?.fields.find((item) => item.key === candidate)?.value ?? "";
      return { field: candidate, section: family, value };
    }
  }
  return null;
}

/** Row-major forms without row IDs: a repeated field starts the next record.
 * Explicit row containers are preferred; the fallback never reuses row zero. */
export class RecordOrder {
  private groups = new Map<string, { index: number; fields: Set<string> }>();
  private assigned = new Map<string, number>();
  index(scope: string, field: string, identity: string): number {
    if (this.assigned.has(identity)) return this.assigned.get(identity)!;
    const group = this.groups.get(scope) ?? { index: 0, fields: new Set<string>() };
    if (group.fields.has(field)) { group.index += 1; group.fields.clear(); }
    group.fields.add(field); this.groups.set(scope, group); this.assigned.set(identity, group.index);
    return group.index;
  }
}

/** Resolve and write each control before considering the next. No precomputed match list. */
export async function walkControls<T>(options: {
  discover: () => T[]; identity: (item: T) => string; visit: (item: T) => Promise<void>;
  cancelled: () => boolean; changed?: () => boolean; reveal?: () => Promise<boolean>; limit?: number;
}): Promise<number> {
  const seen = new Set<string>();
  const deadline = Date.now() + 120_000;
  let queue = options.discover();
  while (!options.cancelled() && seen.size < (options.limit ?? 300) && Date.now() < deadline) {
    const item = queue.shift();
    if (item === undefined) {
      if (!await options.reveal?.()) break;
      queue = options.discover().filter((candidate) => !seen.has(options.identity(candidate)));
      continue;
    }
    const key = options.identity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    await options.visit(item);
    if (options.changed?.()) queue = options.discover().filter((candidate) => !seen.has(options.identity(candidate)));
  }
  return seen.size;
}

function path(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  for (let level = 0; current && level < 24; level++, current = current.parentElement) {
    // ATS repeated cards can reuse the same field ID. IDs are not globally unique here.
    parts.push(`${current.tagName}:${current.id}:${current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.tagName === current!.tagName).indexOf(current) : 0}`);
  }
  return parts.reverse().join("/"); // In-memory only; never exported as diagnostics.
}

const HEADINGS = "h1,h2,h3,h4,h5,legend,[role=heading],[class*='title' i],[class*='section-name' i]";
function contextFor(element: FillableElement, adapter: SiteAdapter): { section: string; scope: string; row?: string } {
  let section = "basic";
  let scope = "basic";
  const headings = Array.from(element.ownerDocument.querySelectorAll<HTMLElement>(HEADINGS));
  for (const heading of headings) {
    if (!(heading.compareDocumentPosition(element) & 4) || !isElementVisible(heading)) continue;
    if (heading.querySelector("input,textarea,select,[role=combobox]")) continue;
    const kind = sectionKey(staticLabelTextOutsideControls(heading, undefined, adapter.dynamicChoiceSelectors));
    if (kind) { section = kind; scope = kind; }
  }
  // Also support forms whose repeated containers carry section metadata.
  const explicit = element.closest<HTMLElement>("[data-gugu-repeat-kind],[data-section],[data-type]");
  const explicitKind = explicit && sectionKey([explicit.dataset.guguRepeatKind, explicit.dataset.section, explicit.dataset.type].filter(Boolean).join(" "));
  if (explicitKind) { section = explicitKind; scope = explicitKind; }
  let row = element.closest<HTMLElement>(adapter.repeatedGroupSelectors.join(","));
  while (row) {
    const fields = Array.from(row.querySelectorAll<FillableElement>("input,textarea,select"))
      .filter((item) => isSemanticInventoryCandidate(item, adapter) && !(isInputElement(item) && ["radio", "checkbox"].includes(item.type)))
      .map((item) => { const hint = describeField(item, adapter); return fieldKey(section, hint.label || hint.ariaLabel || hint.placeholder || hint.name || ""); }).filter(Boolean);
    // A field wrapper or a whole section containing several records is not a record.
    if (fields.length >= 3 && new Set(fields).size === fields.length) return { section, scope, row: path(row) };
    row = row.parentElement?.closest<HTMLElement>(adapter.repeatedGroupSelectors.join(",")) ?? null;
  }
  return { section, scope };
}

export function sameChoice(left: string, right: string): boolean {
  const a = normalizedLabel(left), b = normalizedLabel(right);
  if (a === b) return true;
  return [["男", "male"], ["女", "female"], ["本科", "学士", "bachelor", "bachelors"], ["硕士", "研究生", "master", "masters"], ["博士", "phd", "doctorate"]]
    .some((values) => values.includes(a) && values.includes(b));
}

function nativeValue(value: string, descriptor: FieldDescriptor): string | string[] | null {
  if (descriptor.controlType === "select" || descriptor.controlType === "radio" || descriptor.controlType === "checkbox") {
    if (descriptor.hasValue) return null;
    const options = descriptor.options?.filter((option) => !option.disabled && sameChoice(value, option.label)) ?? [];
    return options.length === 1 ? options[0].value : null;
  }
  if (descriptor.controlType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  if (descriptor.controlType === "tel" && !/^\+?[\d ()-]{6,25}$/.test(value)) return null;
  if (descriptor.controlType === "number" && !/^-?\d+(\.\d+)?$/.test(value)) return null;
  if (descriptor.controlType === "month" || descriptor.controlType === "date") {
    const pieces = value.replace(/[年月/.]/g, "-").replace(/日$/, "").split("-").filter(Boolean);
    if (pieces.length < (descriptor.controlType === "month" ? 2 : 3)) return null;
    return pieces.slice(0, descriptor.controlType === "month" ? 2 : 3).map((piece, i) => i ? piece.padStart(2, "0") : piece).join("-");
  }
  return value;
}

async function chooseCustom(element: FillableElement, value: string, adapter: SiteAdapter, cancelled: () => boolean): Promise<boolean> {
  if (cancelled()) return false;
  const doc = element.ownerDocument;
  const wrapper = element.closest<HTMLElement>(".ud__select,[class*='sd-Select-container-']")
    ?? element.closest<HTMLElement>(adapter.dynamicChoiceSelectors.join(",")) ?? element;
  const button = wrapper.closest("button");
  if (button && button.type !== "button" || wrapper.closest("a[href]")) return false;
  const popupSelector = "[role=listbox],.ant-select-dropdown,.semi-select-option-list,.el-select-dropdown,[class*='select-menu'],[class*='sd-Select-menu-']";
  const before = new Set(Array.from(doc.querySelectorAll<HTMLElement>(popupSelector)).filter(isElementVisible));
  if (isInputElement(element) && sameChoice(value, element.value)) return true;
  wrapper.click();
  await wait(160);
  try {
    if (cancelled() || !element.isConnected) return false;
    const linked = (element.getAttribute("aria-controls") || element.getAttribute("aria-owns") || wrapper.getAttribute("aria-controls") || "").split(/\s+/).map((id) => doc.getElementById(id)).filter((item): item is HTMLElement => Boolean(item && isElementVisible(item)));
    const opened = linked.length ? linked : Array.from(doc.querySelectorAll<HTMLElement>(popupSelector)).filter((popup) => isElementVisible(popup) && !before.has(popup));
    const roots = opened.filter((candidate) => !opened.some((other) => other !== candidate && other.contains(candidate)));
    if (roots.length !== 1) return false;
    const options = Array.from(roots[0].querySelectorAll<HTMLElement>("[role=option],.ant-select-item-option,.semi-select-option,.el-select-dropdown__item,[class*='sd-Select-common-item-']"))
      .filter((option) => isElementVisible(option) && !isEffectivelyDisabled(option) && !/disabled/i.test(option.className)
        && !option.closest("a[href],button:not([type=button])")
        && sameChoice(value, option.getAttribute("title") || (option.textContent || "").replace(/[\uE000-\uF8FF]/g, "")));
    if (options.length !== 1 || cancelled()) return false;
    options[0].click();
    await wait(200);
    const retained = isInputElement(element) && sameChoice(value, element.value)
      || Array.from(wrapper.querySelectorAll<HTMLElement>(".ant-select-selection-item,.semi-select-selection,.el-input__inner,[class*='selected-value'],[class*='sd-Input-display-value-']"))
        .some((item) => sameChoice(value, isInputElement(item) ? item.value : item.textContent ?? ""))
      || sameChoice(value, wrapper.textContent ?? "");
    return Boolean(retained);
  } finally {
    const Keyboard = doc.defaultView?.KeyboardEvent;
    if (Keyboard) element.dispatchEvent(new Keyboard("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    element.blur();
  }
}

export async function fillSequentially(doc: Document, adapter: SiteAdapter, sections: ResumeSection[], options: {
  cancelled: () => boolean; onProgress: (progress: FillProgress) => void; onField: (result: FieldResult) => void;
}): Promise<{ progress: FillProgress; undo: ElementSnapshot[] }> {
  const progress: FillProgress = { visited: 0, filled: 0, failed: 0, skipped: 0, current: "", stopped: false };
  const undo: ElementSnapshot[] = [];
  const order = new RecordOrder();
  const explicitRows = new Map<string, string[]>();
  const docIds = new Map<Document, number>();
  const startLocation = doc.location.href;
  const cancelled = () => options.cancelled() || doc.location.href !== startLocation;
  const observers = new Map<Document, MutationObserver>();
  const handledChoices = new WeakSet<Element>();
  const identities = new WeakMap<Element, string>();
  let mutation = false;
  let scrollRounds = 0;
  const identity = (element: FillableElement) => {
    let key = identities.get(element);
    if (!key) { key = `${docIds.get(element.ownerDocument) ?? 0}:${path(element)}`; identities.set(element, key); }
    return key;
  };
  const discover = () => collectScanDocuments(doc).documents.flatMap((currentDoc, index) => {
    docIds.set(currentDoc, index);
    if (!observers.has(currentDoc)) {
      const observer = new MutationObserver(() => { mutation = true; });
      observer.observe(currentDoc.documentElement, { childList: true, subtree: true });
      observers.set(currentDoc, observer);
    }
    return collectCandidates(currentDoc, adapter).filter((element) => isSemanticInventoryCandidate(element, adapter))
      .sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : a === b ? 0 : 1);
  });
  try {
    await walkControls({
      discover, identity, cancelled,
      changed: () => { const changed = mutation; mutation = false; return changed; },
      reveal: async () => {
        if (scrollRounds++ >= 40 || cancelled()) return false;
        const scroller = doc.scrollingElement;
        if (!scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) return false;
        scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(300, scroller.clientHeight * 0.8));
        await wait(180);
        return true;
      },
      visit: async (element) => {
        if (!element.isConnected || handledChoices.has(element) || isEffectivelyDisabled(element) || isIgnoredByAdapter(element, adapter)) return;
        progress.visited++;
        const dynamic = isDynamicChoiceElement(element, adapter);
        const descriptor = describeField(element, adapter);
        const context = contextFor(element, adapter);
        const draft = resolveResumeValue(sections, descriptor, context.section);
        let recordIndex = 0;
        if (draft && draft.section !== "basic" && !/最高/.test(descriptor.label ?? "")) {
          if (context.row) {
            const scope = `${docIds.get(element.ownerDocument)}:${draft.section}`;
            const rows = explicitRows.get(scope) ?? [];
            if (!rows.includes(context.row)) rows.push(context.row);
            explicitRows.set(scope, rows); recordIndex = rows.indexOf(context.row);
          } else recordIndex = order.index(`${docIds.get(element.ownerDocument)}:${context.scope}:${draft.section}`, draft.field, identity(element));
        }
        const fact = draft && resolveResumeValue(sections, descriptor, draft.section, recordIndex);
        progress.current = descriptor.label || fact?.field || "表单";
        options.onProgress({ ...progress });
        const result = (outcome: StructureOutcome, reason: FieldResult["reason"]) => options.onField({ element, field: fact?.field, section: fact?.section, outcome, reason });
        if (!fact?.value) { progress.skipped++; result("none", fact ? "missing" : "unknown"); return; }
        if ((descriptor.readOnly && !dynamic) || ["file", "hidden", "unknown"].includes(descriptor.controlType) || SENSITIVE.test(progress.current)) { progress.skipped++; result("none", "unsupported"); return; }
        element.scrollIntoView({ block: "center", behavior: "instant" });
        await wait(50);
        if (cancelled() || !element.isConnected) { result("stale", "failed"); progress.failed++; return; }
        if (dynamic) {
          const retained = await chooseCustom(element, fact.value, adapter, cancelled);
          if (retained) progress.filled++; else progress.failed++;
          result(retained ? "retained" : "reverted", retained ? "filled" : "failed");
          return;
        }
        let target: FillTarget = element;
        if (isInputElement(element) && ["radio", "checkbox"].includes(element.type)) {
          if (!element.name) { progress.skipped++; return; }
          const candidates = collectCandidates(element.ownerDocument, adapter).filter((item): item is HTMLInputElement => isInputElement(item) && item.name === element.name && item.type === element.type && item.form === element.form && isElementVisible(item));
          const scoped = scopeNamedChoiceGroup(element, candidates, (item) => item.closest("fieldset,[data-index],[data-row-key]"));
          if (scoped.ambiguous || !scoped.elements.length) { progress.skipped++; return; }
          target = scoped.elements; target.forEach((item) => handledChoices.add(item));
          descriptor.options = target.map((item) => ({ label: optionLabel(item, adapter), value: item.value, disabled: isEffectivelyDisabled(item) }));
          descriptor.hasValue = target.some((item) => item.checked);
        }
        const value = nativeValue(fact.value, descriptor);
        if (value === null || isInputElement(element) && element.maxLength > 0 && fact.value.length > element.maxLength) { progress.skipped++; result("none", "unsupported"); return; }
        // User edits between discovery and this visit are read now, not from a preview.
        const written = await writeAndVerifyTarget(target, value);
        if (written.outcome === "retained") { progress.filled++; undo.push(...written.before); }
        else progress.failed++;
        result(written.outcome, written.outcome === "retained" ? "filled" : "failed");
      },
    });
  } finally { observers.forEach((observer) => observer.disconnect()); }
  progress.stopped = cancelled(); progress.current = ""; options.onProgress({ ...progress });
  return { progress, undo };
}

import type { FieldControl, FieldDescriptor } from "./field-matcher.ts";
import { adapterLabelCandidates, isIgnoredByAdapter, staticLabelTextOutsideControls, type SiteAdapter } from "./site-adapters.ts";
import type { ProfileFieldKey } from "./types.ts";

export type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;
export type FillTarget = FillableElement | HTMLInputElement[];

export interface ElementSnapshot {
  element: FillableElement;
  value: string;
  checked?: boolean;
  selectedValues?: string[];
}

export interface ManualField {
  identity: string;
  label: string;
  reason: string;
  required: boolean;
}

export interface RepeatGroupIdentity {
  groupKey: string;
  signature: string;
}

export class RepeatBindingStore {
  private values = new Map<string, { entryId: string; epoch: number }>();
  private currentEpoch = 0;

  get epoch(): number {
    return this.currentEpoch;
  }

  get(groupKey: string): string | undefined {
    const record = this.values.get(groupKey);
    return record?.epoch === this.currentEpoch ? record.entryId : undefined;
  }

  set(groupKey: string, entryId: string): this {
    this.values.set(groupKey, { entryId, epoch: this.currentEpoch });
    return this;
  }

  delete(groupKey: string): boolean {
    return this.values.delete(groupKey);
  }

  has(groupKey: string): boolean {
    return this.get(groupKey) !== undefined;
  }

  keys(): IterableIterator<string> {
    return this.values.keys();
  }

  invalidate(): number {
    this.currentEpoch += 1;
    this.values.clear();
    return this.currentEpoch;
  }
}

export interface ChoiceGroupScope {
  elements: HTMLInputElement[];
  ambiguous: boolean;
  reason?: "choice_group_has_existing_selection" | "radio_group_crosses_repeat_roots" | "ambiguous_choice_group_scope";
}

export interface SemanticScanCandidate {
  identity: string;
  ownerDocument: Document;
  profileKey: ProfileFieldKey;
  repeated: boolean;
  actionable?: boolean;
}

export interface DuplicateSemanticResolution {
  blockedIds: Set<string>;
  reportIds: Set<string>;
}

export interface SemanticInventoryEntry {
  element: FillableElement;
  descriptor: FieldDescriptor;
}

export interface CachedTargetValidation {
  valid: boolean;
  reason?: "target_replaced" | "target_disconnected" | "target_ineligible" | "target_ignored" | "choice_already_selected" | "semantics_changed" | "value_state_changed" | "value_changed";
}

export interface FrameScan {
  documents: Document[];
  manualFrames: ManualField[];
}

export function isInputElement(element: Element): element is HTMLInputElement {
  return element.tagName === "INPUT";
}

export function isTextareaElement(element: Element): element is HTMLTextAreaElement {
  return element.tagName === "TEXTAREA";
}

export function isSelectElement(element: Element): element is HTMLSelectElement {
  return element.tagName === "SELECT";
}

export function isElementVisible(element: Element): boolean {
  const html = element as HTMLElement;
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(html);
  const rect = html.getBoundingClientRect();
  return Boolean(style && style.display !== "none" && style.visibility !== "hidden" && rect.width >= 4 && rect.height >= 4);
}

function elementOrAncestorHasAriaState(element: Element, name: "aria-disabled" | "aria-readonly"): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.getAttribute(name)?.trim().toLowerCase() === "true") return true;
    current = current.parentElement;
  }
  return false;
}

export function isEffectivelyDisabled(element: FillableElement): boolean {
  let selectorDisabled = false;
  try { selectorDisabled = element.matches(":disabled"); } catch { selectorDisabled = false; }
  return selectorDisabled
    || ("disabled" in element && Boolean(element.disabled))
    || elementOrAncestorHasAriaState(element, "aria-disabled");
}

export function isEffectivelyReadOnly(element: FillableElement): boolean {
  return ("readOnly" in element && Boolean(element.readOnly))
    || elementOrAncestorHasAriaState(element, "aria-readonly");
}

export function selectHasCurrentValue(element: HTMLSelectElement): boolean {
  if (element.value !== "") return true;
  return element.multiple && Array.from(element.options).some((option) => option.selected && option.value !== "");
}

function isOptionEffectivelyDisabled(option: HTMLOptionElement): boolean {
  let selectorDisabled = false;
  try { selectorDisabled = option.matches(":disabled"); } catch { selectorDisabled = false; }
  const parent = option.parentElement as HTMLOptGroupElement | null;
  return option.disabled
    || selectorDisabled
    || Boolean(parent?.tagName === "OPTGROUP" && parent.disabled);
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").replace(/[*：:]+$/g, "").trim();
}

function cssEscape(value: string, ownerDocument: Document): string {
  return ownerDocument.defaultView?.CSS?.escape ? ownerDocument.defaultView.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export function fileControlHasVisibleProxy(element: HTMLInputElement): boolean {
  if (isElementVisible(element)) return true;
  const ownerDocument = element.ownerDocument;
  const escapedId = element.id ? cssEscape(element.id, ownerDocument) : "";
  const associated = escapedId ? ownerDocument.querySelector(`label[for="${escapedId}"]`) : null;
  const enclosing = element.closest("label, [class*='upload' i], [class*='attachment' i]");
  if ((associated && isElementVisible(associated)) || (enclosing && isElementVisible(enclosing))) return true;
  let branch: Element = element;
  let container = element.parentElement;
  for (let depth = 0; container && depth < 3; depth += 1) {
    const nearby = Array.from(container.children).filter((candidate) => candidate !== branch);
    for (const candidate of nearby) {
      if (isVisibleUploadProxy(candidate)) return true;
      const nested = Array.from(candidate.querySelectorAll("button, label, [role='button'], [class*='upload' i], [class*='attachment' i]"))
        .slice(0, 24);
      if (nested.some((item) => isVisibleUploadProxy(item))) return true;
    }
    if (container.tagName === "FORM") break;
    branch = container;
    container = container.parentElement;
  }
  return false;
}

function isVisibleUploadProxy(element: Element): boolean {
  if (!isElementVisible(element)) return false;
  const signal = [
    element.tagName,
    element.className,
    element.getAttribute("role"),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.textContent,
  ].filter(Boolean).join(" ");
  const interactive = ["BUTTON", "LABEL"].includes(element.tagName) || element.getAttribute("role") === "button";
  return (interactive || /(upload|attachment|resume|file|上传|附件|简历|文件)/i.test(signal))
    && /(upload|attachment|resume|choose\s*file|browse|上传|附件|简历|选择文件)/i.test(signal);
}

export function collectCandidates(scanDocument: Document, adapter: SiteAdapter): FillableElement[] {
  const ordinary = Array.from(scanDocument.querySelectorAll<FillableElement>("input, textarea, select, [contenteditable=true]"));
  const customSelector = adapter.dynamicChoiceSelectors.join(",");
  const custom = customSelector
    ? Array.from(scanDocument.querySelectorAll<HTMLElement>(customSelector)).filter((element) => (
      !isSelectElement(element)
      && !ordinary.includes(element)
      && !element.querySelector("input, textarea, select, [contenteditable=true]")
    ))
    : [];
  return [...ordinary, ...custom];
}

function isPotentialFormFrame(frame: HTMLIFrameElement): boolean {
  if (!isElementVisible(frame)) return false;
  const signal = [frame.title, frame.name, frame.getAttribute("aria-label"), frame.getAttribute("src")]
    .filter(Boolean)
    .join(" ");
  if (/(apply|application|resume|candidate|form|job|career|招聘|投递|简历)/i.test(signal)) return true;
  const rect = frame.getBoundingClientRect();
  return rect.width >= 240 && rect.height >= 120;
}

function safeFrameLabel(frame: HTMLIFrameElement): string {
  const label = cleanText(frame.title || frame.getAttribute("aria-label") || frame.name).slice(0, 80);
  if (label) return label;
  try {
    const hostname = new URL(frame.getAttribute("src") || "", frame.ownerDocument.location.href).hostname;
    return hostname ? `iframe (${hostname})` : "iframe";
  } catch {
    return "iframe";
  }
}

/**
 * Recursively returns only DOM documents the page allowed us to read. A
 * cross-origin or not-yet-ready frame is never probed further and is surfaced
 * as an explicit manual item instead of disappearing from coverage.
 */
export function collectScanDocuments(root: Document): FrameScan {
  const documents: Document[] = [];
  const manualFrames: ManualField[] = [];
  const visited = new Set<Document>();
  const visit = (scanDocument: Document, documentPath: string) => {
    if (visited.has(scanDocument)) return;
    visited.add(scanDocument);
    documents.push(scanDocument);
    const frames = Array.from(scanDocument.querySelectorAll<HTMLIFrameElement>("iframe"));
    for (const [frameIndex, frame] of frames.entries()) {
      if (!isPotentialFormFrame(frame)) continue;
      let child: Document | null = null;
      try { child = frame.contentDocument; } catch { child = null; }
      if (child?.documentElement) {
        visit(child, `${documentPath}.${frameIndex}`);
      } else {
        manualFrames.push({
          identity: `frame:${documentPath}.${frameIndex}`,
          label: safeFrameLabel(frame),
          reason: frame.getAttribute("src") ? "cross_origin_iframe" : "iframe_not_ready",
          required: false,
        });
      }
    }
  };
  visit(root, "0");
  return { documents, manualFrames };
}

export function registerFrameLoadListeners(
  documents: Document[],
  onFrameLoad: (frame: HTMLIFrameElement) => void,
): Array<() => void> {
  return documents.map((scanDocument) => {
    const listener = (event: Event) => {
      const target = event.target as { tagName?: string } | null;
      if (target?.tagName === "IFRAME") onFrameLoad(event.target as HTMLIFrameElement);
    };
    scanDocument.addEventListener("load", listener, true);
    return () => scanDocument.removeEventListener("load", listener, true);
  });
}

export function isDynamicChoiceElement(element: FillableElement, adapter: SiteAdapter): boolean {
  if (isSelectElement(element)) return false;
  return adapter.dynamicChoiceSelectors.some((selector) => {
    try { return element.matches(selector) || Boolean(element.closest(selector)); } catch { return false; }
  });
}

/**
 * Returns whether a control may participate in the read-only semantic
 * inventory.  Unlike `isEligible`, this intentionally keeps controls that are
 * already filled, disabled, or readonly: they are useful duplicate sentinels
 * even though they must never become fill targets.
 *
 * Sensitive and action-only controls are excluded before their descriptors
 * are built.  In particular, this path never needs to inspect a password,
 * attachment, or hidden value.
 */
export function isSemanticInventoryCandidate(element: FillableElement, adapter: SiteAdapter): boolean {
  // Filter sensitive/action controls before any code is allowed to inspect
  // their value-like state or descendant text.
  if (isIgnoredByAdapter(element, adapter)) return false;
  if (isInputElement(element) && ["hidden", "password", "file", "submit", "button", "reset", "image"].includes(element.type)) {
    return false;
  }
  return isElementVisible(element);
}

const OVERWRITABLE_TEXT_TYPES = new Set(["text", "email", "tel", "url", "date", "month", "number"]);

export function isEligible(element: FillableElement, adapter: SiteAdapter, allowOverwriteExistingText = false): boolean {
  if (isInputElement(element) && element.type === "file") {
    return !isEffectivelyDisabled(element) && !isEffectivelyReadOnly(element) && fileControlHasVisibleProxy(element);
  }
  if (!isElementVisible(element)) return false;
  if (isEffectivelyDisabled(element) || isEffectivelyReadOnly(element)) return false;
  if (isInputElement(element)) {
    if (["hidden", "password", "submit", "button", "reset", "image"].includes(element.type)) return false;
    if (!["checkbox", "radio"].includes(element.type) && element.value.trim()
      && !(allowOverwriteExistingText && OVERWRITABLE_TEXT_TYPES.has(element.type))) return false;
  } else if (isTextareaElement(element) || isSelectElement(element)) {
    if (isTextareaElement(element) && element.value.trim() && !allowOverwriteExistingText) return false;
    if (isSelectElement(element) && selectHasCurrentValue(element)) return false;
  } else if (!isDynamicChoiceElement(element, adapter) && element.textContent?.trim()) return false;
  return true;
}

function nearbySiblingLabel(element: FillableElement, adapter: SiteAdapter): string {
  // Some ATS layouts place a static label beside an input *wrapper* rather
  // than associating it with the input. Stay inside a small field row: a
  // section-level heading must not be borrowed by every control below it.
  const controls = "input, textarea, select, [contenteditable=true], [role='combobox'], [role='textbox']";
  let branch: HTMLElement = element;
  for (let depth = 0; depth < 3; depth += 1) {
    const parent = branch.parentElement;
    if (!parent || ["FORM", "BODY", "HTML", "FIELDSET"].includes(parent.tagName)) break;
    if (parent.querySelectorAll(controls).length > 2) break;
    const sibling = branch.previousElementSibling as HTMLElement | null;
    if (sibling && !sibling.matches(controls) && !sibling.querySelector(controls)) {
      const value = cleanText(staticLabelTextOutsideControls(sibling, element, adapter.dynamicChoiceSelectors));
      if (value.length > 0 && value.length <= 48 && /[\u3400-\u9fffA-Za-z]/u.test(value)
        && !/@|https?:|1[3-9]\d{9}|^(请输入|请选择|中国大陆)/iu.test(value)) return value;
    }
    branch = parent;
  }
  return "";
}

function describeFieldSemantics(element: FillableElement, adapter: SiteAdapter): Pick<FieldDescriptor, "label" | "labelSource" | "ariaLabel" | "placeholder" | "name"> {
  const ownerDocument = element.ownerDocument;
  let label = "";
  let labelSource: FieldDescriptor["labelSource"] = "none";
  if (element.id) {
    const associated = ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(element.id, ownerDocument)}"]`);
    if (associated) {
      label = cleanText(staticLabelTextOutsideControls(associated, element, adapter.dynamicChoiceSelectors));
      if (label) labelSource = "associated";
    }
  }
  if (!label) {
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) {
      label = cleanText(staticLabelTextOutsideControls(wrappingLabel as HTMLElement, element, adapter.dynamicChoiceSelectors));
      if (label) labelSource = "wrapping";
    }
  }
  if (!label) {
    // Actual ATS field wrappers, not the selected-value label inside a dropdown.
    const field = element.closest(".ud-formily-item,.mtd-form-item-body");
    const title = field?.querySelector<HTMLElement>(".ud-formily-item-label,.label");
    if (title && !title.querySelector("input,textarea,select")) {
      label = cleanText(staticLabelTextOutsideControls(title, element, adapter.dynamicChoiceSelectors));
      if (label) labelSource = "container";
    }
  }
  if (!label) {
    label = nearbySiblingLabel(element, adapter);
    if (label) labelSource = "nearby";
  }
  if (!label) {
    const container = element.closest(".ud-formily-item, [class*='form-item'], [class*='field'], [class*='question'], .ant-form-item, .el-form-item");
    const explicit = container?.querySelector<HTMLElement>("label, [class*='label'], [class*='title']");
    if (explicit && explicit !== element) {
      label = cleanText(staticLabelTextOutsideControls(explicit, element, adapter.dynamicChoiceSelectors)).slice(0, 120);
      if (label) labelSource = "container";
    }
  }
  if (!label) {
    label = adapterLabelCandidates(element, adapter).map(cleanText).find(Boolean)?.slice(0, 120) ?? "";
    if (label) labelSource = "adapter";
  }
  return {
    label,
    labelSource,
    ariaLabel: cleanText(element.getAttribute("aria-label")),
    placeholder: cleanText(element.getAttribute("placeholder") ?? element.getAttribute("data-placeholder")),
    name: cleanText(element.getAttribute("name") ?? element.id),
  };
}

/**
 * Describes only stable field semantics.  It deliberately does not read the
 * current value, selected option values, or arbitrary row text, so the result
 * can be used as a duplicate sentinel without retaining or hashing PII.
 */
export function describeSemanticField(element: FillableElement, adapter: SiteAdapter): FieldDescriptor | null {
  if (!isSemanticInventoryCandidate(element, adapter)) return null;
  const semantics = describeFieldSemantics(element, adapter);
  const autocomplete = isInputElement(element) ? cleanText(element.autocomplete) : "";
  if (![semantics.label, semantics.ariaLabel, semantics.placeholder, semantics.name, autocomplete].some((value) => Boolean(cleanText(value)))) {
    return null;
  }
  return {
    ...semantics,
    autocomplete,
    controlType: elementControl(element, adapter),
    required: element.hasAttribute("required")
      || element.getAttribute("aria-required") === "true"
      || Boolean(element.closest("[class*='required' i], .ant-form-item-required, .semi-form-field-label-required")),
    multiple: isSelectElement(element) && element.multiple,
  };
}

/**
 * First phase of a page scan: inventory every safe ordinary control without
 * reading its value-like state. Named choices are handled once per scoped
 * group by the caller, rather than once per option.
 */
export function collectSemanticInventory(
  candidates: FillableElement[],
  adapter: SiteAdapter,
): SemanticInventoryEntry[] {
  const inventory: SemanticInventoryEntry[] = [];
  for (const element of candidates) {
    if (isInputElement(element) && ["radio", "checkbox"].includes(element.type) && element.name) continue;
    const descriptor = describeSemanticField(element, adapter);
    if (descriptor) inventory.push({ element, descriptor });
  }
  return inventory;
}

export function describeField(element: FillableElement, adapter: SiteAdapter): FieldDescriptor {
  const semantics = describeFieldSemantics(element, adapter);
  return {
    ...semantics,
    autocomplete: isInputElement(element) ? element.autocomplete : "",
    controlType: elementControl(element, adapter),
    required: element.hasAttribute("required") || element.getAttribute("aria-required") === "true" || Boolean(element.closest("[class*='required' i], .ant-form-item-required, .semi-form-field-label-required")),
    disabled: isEffectivelyDisabled(element),
    readOnly: isEffectivelyReadOnly(element),
    hasValue: isInputElement(element)
      ? ["radio", "checkbox"].includes(element.type)
        ? element.checked
        : Boolean(element.value.trim())
      : isTextareaElement(element)
        ? Boolean(element.value.trim())
      : isSelectElement(element)
        ? selectHasCurrentValue(element)
        : false,
    multiple: isSelectElement(element) && element.multiple,
    options: isSelectElement(element)
      ? Array.from(element.options).map((option) => ({
          label: cleanText(option.text),
          value: option.value,
          disabled: isOptionEffectivelyDisabled(option),
        }))
      : [],
  };
}

export function optionLabel(element: HTMLInputElement, adapter: SiteAdapter): string {
  const ownerDocument = element.ownerDocument;
  if (element.id) {
    const label = ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(element.id, ownerDocument)}"]`);
    if (label) return cleanText(staticLabelTextOutsideControls(label, element, adapter.dynamicChoiceSelectors));
  }
  const wrapping = element.closest("label");
  return wrapping ? cleanText(staticLabelTextOutsideControls(wrapping as HTMLElement, element, adapter.dynamicChoiceSelectors)) : "";
}

function defaultChoiceContainer(element: HTMLInputElement): Element | null {
  return element.closest("fieldset, [role='radiogroup'], [role='group'], [class*='form-item' i], [class*='field' i], [class*='question' i], [data-field]");
}

/**
 * A name is not a page-wide choice-group identifier: repeated ATS rows often
 * clone it verbatim. Scope choices to one detected repeat root (or one bounded
 * form container). Mixed owned/unowned candidates are ambiguous and must not
 * be written as a group.
 */
export function scopeNamedChoiceGroup(
  anchor: HTMLInputElement,
  candidates: HTMLInputElement[],
  repeatRootFor: (element: HTMLInputElement) => Element | null,
  containerFor: (element: HTMLInputElement) => Element | null = defaultChoiceContainer,
): ChoiceGroupScope {
  if (candidates.some((candidate) => candidate.checked)) {
    return { elements: candidates, ambiguous: true, reason: "choice_group_has_existing_selection" };
  }
  const repeatRoots = new Map(candidates.map((candidate) => [candidate, repeatRootFor(candidate)]));
  const hasRepeated = [...repeatRoots.values()].some(Boolean);
  const hasUnowned = [...repeatRoots.values()].some((root) => !root);
  const distinctRepeatRoots = new Set([...repeatRoots.values()].filter((root): root is Element => Boolean(root)));
  if (anchor.type === "radio" && distinctRepeatRoots.size > 1) {
    return { elements: candidates, ambiguous: true, reason: "radio_group_crosses_repeat_roots" };
  }
  if (hasRepeated && hasUnowned) {
    return { elements: candidates, ambiguous: true, reason: "ambiguous_choice_group_scope" };
  }

  const anchorRepeatRoot = repeatRoots.get(anchor) ?? null;
  if (anchorRepeatRoot) {
    return {
      elements: candidates.filter((candidate) => repeatRoots.get(candidate) === anchorRepeatRoot),
      ambiguous: false,
    };
  }

  const containers = new Map(candidates.map((candidate) => [candidate, containerFor(candidate)]));
  const hasContainer = [...containers.values()].some(Boolean);
  const hasNoContainer = [...containers.values()].some((container) => !container);
  if (hasContainer && hasNoContainer) {
    return { elements: candidates, ambiguous: true, reason: "ambiguous_choice_group_scope" };
  }
  const distinctContainers = new Set([...containers.values()].filter((container): container is Element => Boolean(container)));
  if (distinctContainers.size > 1 || (!hasContainer && candidates.length > 1)) {
    return { elements: candidates, ambiguous: true, reason: "ambiguous_choice_group_scope" };
  }
  return { elements: candidates, ambiguous: false };
}

/**
 * Repeated controls are safe when every matching semantic is explicitly bound
 * to a repeat context. If any matching field in the same document fell back to
 * a scalar, fail the whole semantic group closed.
 */
export function duplicateSemanticCandidateIds(candidates: SemanticScanCandidate[]): Set<string> {
  const byDocument = new Map<Document, Map<ProfileFieldKey, SemanticScanCandidate[]>>();
  for (const candidate of candidates) {
    let byKey = byDocument.get(candidate.ownerDocument);
    if (!byKey) {
      byKey = new Map();
      byDocument.set(candidate.ownerDocument, byKey);
    }
    const group = byKey.get(candidate.profileKey) ?? [];
    group.push(candidate);
    byKey.set(candidate.profileKey, group);
  }
  const unsafe = new Set<string>();
  for (const byKey of byDocument.values()) {
    for (const group of byKey.values()) {
      if (group.length > 1 && group.some((candidate) => !candidate.repeated)) {
        for (const candidate of group) unsafe.add(candidate.identity);
      }
    }
  }
  return unsafe;
}

/**
 * Separates write blocking from UI reporting. Read-only sentinels participate
 * in duplicate detection, but only an actionable field may become a new
 * manual item or increase required-field counts.
 */
export function resolveDuplicateSemanticCandidates(candidates: SemanticScanCandidate[]): DuplicateSemanticResolution {
  const blockedIds = duplicateSemanticCandidateIds(candidates);
  return {
    blockedIds,
    reportIds: new Set(candidates
      .filter((candidate) => candidate.actionable && blockedIds.has(candidate.identity))
      .map((candidate) => candidate.identity)),
  };
}

function elementControl(element: FillableElement, adapter: SiteAdapter): FieldControl {
  if (isDynamicChoiceElement(element, adapter)) return "combobox";
  if (isTextareaElement(element)) return "textarea";
  if (isSelectElement(element)) return "select";
  if (isInputElement(element)) {
    const supported = new Set<FieldControl>(["text", "email", "tel", "url", "date", "month", "number", "radio", "checkbox", "file", "hidden"]);
    return supported.has(element.type as FieldControl) ? element.type as FieldControl : "text";
  }
  return element.isContentEditable ? "contenteditable" : "unknown";
}

export function resolveRepeatGroupIdentity(
  root: Element,
  signature: string,
  groupIds: WeakMap<Element, RepeatGroupIdentity>,
  bindings: RepeatBindingStore,
  allocateKey: () => string,
): { groupKey: string; targetEntryId?: string; invalidatedGroupKey?: string } {
  const previous = groupIds.get(root);
  if (!previous || previous.signature !== signature) {
    if (previous) bindings.delete(previous.groupKey);
    const next = { groupKey: allocateKey(), signature };
    groupIds.set(root, next);
    return {
      groupKey: next.groupKey,
      targetEntryId: bindings.get(next.groupKey),
      ...(previous ? { invalidatedGroupKey: previous.groupKey } : {}),
    };
  }
  return { groupKey: previous.groupKey, targetEntryId: bindings.get(previous.groupKey) };
}

function structuralToken(value: string | null | undefined): string {
  return cleanText(value).normalize("NFKC").toLowerCase().slice(0, 160);
}

function stableStructureHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `structure-v1-${hash.toString(16).padStart(16, "0")}`;
}

/**
 * Builds a session-only hash from form structure and field semantics. It
 * intentionally never reads input values or arbitrary row text, and the raw
 * structural tokens are not retained in the binding store.
 */
export function repeatGroupStructureSignature(
  root: Element,
  kind: string,
  position: number,
  adapter: SiteAdapter,
  nodeIds: WeakMap<Element, string>,
  allocateNodeId: () => string,
): string {
  const nodeId = (element: Element) => {
    let id = nodeIds.get(element);
    if (!id) {
      id = allocateNodeId();
      nodeIds.set(element, id);
    }
    return id;
  };
  const attributes = (element: Element, names: string[]) => names.map((name) => structuralToken(element.getAttribute(name)));
  const rootShape = [
    structuralToken(root.tagName),
    ...attributes(root, ["id", "data-index", "data-row-key", "data-key", "data-section", "data-type", "data-gugu-repeat-kind", "aria-label"]),
  ];
  const controls = Array.from(root.querySelectorAll("input, textarea, select, [contenteditable=true], [role=combobox]"))
    .flatMap((control) => {
      const descriptor = describeSemanticField(control as FillableElement, adapter);
      if (!descriptor) return [];
      return [
        [
          nodeId(control),
          structuralToken(control.tagName),
          ...attributes(control, ["type", "id", "name", "role", "aria-label", "placeholder", "data-field", "data-index", "data-row-key"]),
          structuralToken(descriptor.label),
          structuralToken(descriptor.ariaLabel),
          structuralToken(descriptor.placeholder),
          structuralToken(descriptor.name),
        ].join(":"),
      ];
    });
  return stableStructureHash([structuralToken(kind), String(position), ...rootShape, ...controls].join("|"));
}

export function repeatedMatchIdentity(baseElementId: string, groupKey?: string, epoch?: number): string {
  return groupKey ? `${baseElementId}@${groupKey}#${epoch ?? 0}` : baseElementId;
}

export function deduplicateManualFields(items: ManualField[]): ManualField[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const identity = `${item.identity}:${item.required}:${item.reason}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function snapshotTarget(target: FillTarget): ElementSnapshot[] {
  const items = Array.isArray(target) ? target : [target];
  return items.map((element) => ({
    element,
    value: isInputElement(element) || isTextareaElement(element) || isSelectElement(element)
      ? element.value
      : element.textContent ?? "",
    checked: isInputElement(element) && ["radio", "checkbox"].includes(element.type) ? element.checked : undefined,
    selectedValues: isSelectElement(element)
      ? Array.from(element.options).filter((option) => option.selected).map((option) => option.value) : undefined,
  }));
}

/** A native setter/event dispatch is only an attempt; the page may immediately revert it. */
export function targetRetainsPlannedValue(target: FillTarget, value: string | string[]): boolean {
  const requested = Array.isArray(value) ? value : [value];
  if (!requested.length || new Set(requested).size !== requested.length) return false;
  if (Array.isArray(target)) {
    if (!target.length || target.some((element) => !element.isConnected)) return false;
    const selected = target.filter((element) => element.checked).map((element) => element.value);
    return selected.length === requested.length && requested.every((item) => selected.includes(item));
  }
  if (!target.isConnected) return false;
  if (isSelectElement(target)) {
    const selected = Array.from(target.options).filter((option) => option.selected).map((option) => option.value);
    return selected.length === requested.length && requested.every((item) => selected.includes(item));
  }
  if (Array.isArray(value)) return false;
  if (isInputElement(target) || isTextareaElement(target)) return target.value === value;
  return target.textContent === value;
}

function targetMatchesSnapshot(target: FillTarget, snapshots: ElementSnapshot[]): boolean {
  const elements = Array.isArray(target) ? target : [target];
  if (elements.length !== snapshots.length) return false;
  return elements.every((element, index) => {
    const snapshot = snapshots[index];
    const current = snapshotTarget(element)[0];
    return snapshot.element === element && snapshot.value === current.value && snapshot.checked === current.checked
      && JSON.stringify(snapshot.selectedValues) === JSON.stringify(current.selectedValues);
  });
}

function sameTargetIdentity(cached: FillTarget, current: FillTarget): boolean {
  const cachedItems = Array.isArray(cached) ? cached : [cached];
  const currentItems = Array.isArray(current) ? current : [current];
  return cachedItems.length === currentItems.length
    && cachedItems.every((element, index) => element === currentItems[index]);
}

function descriptorSnapshot(descriptor: FieldDescriptor): string {
  const repeated = descriptor.repeated
    ? {
        groupKey: descriptor.repeated.groupKey,
        groupLabel: descriptor.repeated.groupLabel,
        kind: descriptor.repeated.kind,
        field: descriptor.repeated.field,
        targetEntryId: descriptor.repeated.targetEntryId ?? "",
      }
    : null;
  return JSON.stringify({
    label: descriptor.label,
    labelSource: descriptor.labelSource,
    ariaLabel: descriptor.ariaLabel,
    placeholder: descriptor.placeholder,
    name: descriptor.name,
    autocomplete: descriptor.autocomplete,
    controlType: descriptor.controlType,
    required: descriptor.required,
    multiple: descriptor.multiple,
    options: (descriptor.options ?? []).map((option) => ({ label: option.label, value: option.value, disabled: option.disabled })),
    repeated,
  });
}

/**
 * Re-checks a cached target immediately before writing. Current values are
 * read only to prove the control is still blank; they are never used to derive
 * or retain repeat bindings.
 */
export function validateCachedFillTarget(
  cachedTarget: FillTarget,
  currentTarget: FillTarget,
  cachedDescriptor: FieldDescriptor,
  currentDescriptor: FieldDescriptor,
  adapter: SiteAdapter,
  options: { allowOverwriteExistingText?: boolean; expectedSnapshots?: ElementSnapshot[] } = {},
): CachedTargetValidation {
  if (!sameTargetIdentity(cachedTarget, currentTarget)) return { valid: false, reason: "target_replaced" };
  const elements = Array.isArray(currentTarget) ? currentTarget : [currentTarget];
  if (elements.some((element) => !element.isConnected)) return { valid: false, reason: "target_disconnected" };
  if (elements.some((element) => isIgnoredByAdapter(element, adapter))) return { valid: false, reason: "target_ignored" };
  if (elements.some((element) => !isEligible(element, adapter, options.allowOverwriteExistingText))) return { valid: false, reason: "target_ineligible" };
  if (Boolean(cachedDescriptor.hasValue) !== Boolean(currentDescriptor.hasValue)) return { valid: false, reason: "value_state_changed" };
  if (cachedDescriptor.hasValue && (!options.allowOverwriteExistingText || !options.expectedSnapshots
    || !targetMatchesSnapshot(currentTarget, options.expectedSnapshots))) return { valid: false, reason: "value_changed" };
  if (elements.some((element) => isInputElement(element) && ["radio", "checkbox"].includes(element.type) && element.checked)) {
    return { valid: false, reason: "choice_already_selected" };
  }
  if (descriptorSnapshot(cachedDescriptor) !== descriptorSnapshot(currentDescriptor)) {
    return { valid: false, reason: "semantics_changed" };
  }
  return { valid: true };
}

function setNativeProperty(element: Element, property: "value" | "checked", value: string | boolean): void {
  let prototype = Object.getPrototypeOf(element) as object | null;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor?.set) {
      descriptor.set.call(element, value);
      return;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  (element as unknown as Record<string, string | boolean>)[property] = value;
}

function inputEventFor(element: Element, value: string): Event {
  const ViewInputEvent = element.ownerDocument.defaultView?.InputEvent;
  return ViewInputEvent
    ? new ViewInputEvent("input", { bubbles: true, inputType: "insertText", data: value })
    : basicEventFor(element, "input");
}

function basicEventFor(element: Element, type: string): Event {
  const ViewEvent = element.ownerDocument.defaultView?.Event ?? Event;
  return new ViewEvent(type, { bubbles: true });
}

export function fillTarget(target: FillTarget, value: string | string[]): boolean {
  try {
    const elements = Array.isArray(target) ? target : [target];
    const element = elements[0];
    // Some controlled inputs initialize their value on focus. Focus BEFORE writing.
    element.focus();
    if (Array.isArray(target)) {
      const requested = Array.isArray(value) ? value : [value];
      const choiceType = target[0]?.type;
      if (!requested.length || new Set(requested).size !== requested.length) return false;
      if (!choiceType || !["radio", "checkbox"].includes(choiceType) || target.some((input) => input.type !== choiceType)) return false;
      if (choiceType === "radio" && requested.length !== 1) return false;
      if (target.some((input) => input.checked)) return false;
      const writable = target.filter((input) => !isEffectivelyDisabled(input) && !isEffectivelyReadOnly(input));
      const planned: HTMLInputElement[] = [];
      for (const item of requested) {
        const matches = writable.filter((input) => input.value === item);
        if (matches.length !== 1) return false;
        planned.push(matches[0]);
      }
      if (new Set(planned).size !== planned.length) return false;
      planned[0].scrollIntoView({ block: "center", behavior: "smooth" });
      for (const input of planned) {
        setNativeProperty(input, "checked", true);
        input.dispatchEvent(basicEventFor(input, "input"));
        input.dispatchEvent(basicEventFor(input, "change"));
      }
      return true;
    }
    if (isSelectElement(element)) {
      const requested = Array.isArray(value) ? value : [value];
      if (!requested.length || new Set(requested).size !== requested.length) return false;
      if (!element.multiple && requested.length !== 1) return false;
      const writable = Array.from(element.options).filter((option) => !isOptionEffectivelyDisabled(option));
      const planned: HTMLOptionElement[] = [];
      for (const item of requested) {
        const matches = writable.filter((option) => option.value === item);
        if (matches.length !== 1) return false;
        planned.push(matches[0]);
      }
      if (new Set(planned).size !== planned.length || selectHasCurrentValue(element)) return false;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      const selected = new Set(planned);
      for (const option of writable) option.selected = selected.has(option);
    } else if (isInputElement(element)) {
      if (Array.isArray(value)) return false;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      setNativeProperty(element, "value", value);
    } else if (isTextareaElement(element)) {
      if (Array.isArray(value)) return false;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      setNativeProperty(element, "value", value);
    } else {
      if (Array.isArray(value)) return false;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.textContent = value;
    }
    const eventValue = Array.isArray(value) ? value.join(",") : value;
    element.dispatchEvent(inputEventFor(element, eventValue));
    element.dispatchEvent(basicEventFor(element, "change"));
    // A fabricated blur leaves document.activeElement unchanged and omits focusout
    // (used by React/onBlur and ATS validation). Native blur commits the edit.
    element.blur();
    return true;
  } catch {
    return false;
  }
}

export function restoreElement(snapshot: ElementSnapshot): boolean {
  const { element, value, checked } = snapshot;
  if (!element.isConnected) return false;
  try {
    if (isInputElement(element) && checked !== undefined) {
      setNativeProperty(element, "checked", checked);
    } else if (isSelectElement(element)) {
      if (snapshot.selectedValues) {
        const selected = new Set(snapshot.selectedValues);
        for (const option of element.options) option.selected = selected.has(option.value);
      } else element.value = value;
    } else if (isInputElement(element) || isTextareaElement(element)) {
      setNativeProperty(element, "value", value);
    } else element.textContent = value;
    element.dispatchEvent(inputEventFor(element, value));
    element.dispatchEvent(basicEventFor(element, "change"));
    return true;
  } catch {
    return false;
  }
}

export type VerifiedWriteOutcome = "retained" | "cleared" | "restored" | "reverted";

/** A failed write is compensated against the exact original controls, never a replacement. */
export async function writeAndVerifyTarget(
  target: FillTarget,
  value: string | string[],
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<{ attempted: boolean; outcome: VerifiedWriteOutcome; before: ElementSnapshot[] }> {
  const before = snapshotTarget(target);
  const attempted = fillTarget(target, value);
  if (attempted) {
    await wait(180);
    if (targetRetainsPlannedValue(target, value)) {
      await wait(240);
      if (targetRetainsPlannedValue(target, value)) return { attempted, outcome: "retained", before };
    }
  }
  const restored = before.every((snapshot) => restoreElement(snapshot));
  if (restored) await wait(60);
  const equal = restored && before.every((snapshot) => {
    const current = snapshotTarget(snapshot.element)[0];
    return snapshot.element.isConnected && snapshot.value === current.value && snapshot.checked === current.checked
      && JSON.stringify(snapshot.selectedValues) === JSON.stringify(current.selectedValues);
  });
  const hadPriorValue = before.some((snapshot) => snapshot.value.trim() || snapshot.checked
    || snapshot.selectedValues?.some((selected) => selected.trim()));
  return { attempted, outcome: equal ? hadPriorValue ? "restored" : "cleared" : "reverted", before };
}

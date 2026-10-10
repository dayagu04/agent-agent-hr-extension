import type { FieldControl, FieldDescriptor } from "./field-matcher.ts";
import { adapterLabelCandidates, isIgnoredByAdapter, type SiteAdapter } from "./site-adapters.ts";

export type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;
export type FillTarget = FillableElement | HTMLInputElement[];

export interface ElementSnapshot {
  element: FillableElement;
  value: string;
  checked?: boolean;
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
}

export interface CachedTargetValidation {
  valid: boolean;
  reason?: "target_replaced" | "target_disconnected" | "target_ineligible" | "target_ignored" | "choice_already_selected" | "semantics_changed";
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

export function isDynamicChoiceElement(element: FillableElement, adapter: SiteAdapter): boolean {
  if (isSelectElement(element)) return false;
  return adapter.dynamicChoiceSelectors.some((selector) => {
    try { return element.matches(selector) || Boolean(element.closest(selector)); } catch { return false; }
  });
}

export function isEligible(element: FillableElement, adapter: SiteAdapter): boolean {
  if (isInputElement(element) && element.type === "file") return fileControlHasVisibleProxy(element);
  if (!isElementVisible(element)) return false;
  if (isInputElement(element)) {
    if (["hidden", "password", "submit", "button", "reset", "image"].includes(element.type)) return false;
    if (element.disabled || element.readOnly) return false;
    if (!["checkbox", "radio"].includes(element.type) && element.value.trim()) return false;
  } else if (isTextareaElement(element) || isSelectElement(element)) {
    if (element.disabled || ("readOnly" in element && element.readOnly)) return false;
    if (isTextareaElement(element) && element.value.trim()) return false;
    if (isSelectElement(element) && element.value && element.selectedIndex > 0) return false;
  } else if (!isDynamicChoiceElement(element, adapter) && element.textContent?.trim()) return false;
  return true;
}

function describeFieldSemantics(element: FillableElement, adapter: SiteAdapter): Pick<FieldDescriptor, "label" | "ariaLabel" | "placeholder" | "name"> {
  const parts = new Set<string>();
  const ownerDocument = element.ownerDocument;
  if (element.id) {
    const label = ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(element.id, ownerDocument)}"]`);
    if (label) parts.add(cleanText(label.innerText));
  }
  const wrappingLabel = element.closest("label");
  if (wrappingLabel) parts.add(cleanText(wrappingLabel.textContent));
  const container = element.closest("[class*='form-item'], [class*='field'], [class*='question'], .ant-form-item, .el-form-item");
  if (container) {
    const explicit = container.querySelector<HTMLElement>("label, [class*='label'], [class*='title']");
    if (explicit && explicit !== element) parts.add(cleanText(explicit.innerText).slice(0, 120));
  }
  const previous = element.previousElementSibling as HTMLElement | null;
  if (previous) parts.add(cleanText(previous.innerText).slice(0, 100));
  for (const candidate of adapterLabelCandidates(element, adapter)) parts.add(cleanText(candidate).slice(0, 120));
  return {
    label: Array.from(parts).filter(Boolean).join(" | "),
    ariaLabel: cleanText(element.getAttribute("aria-label")),
    placeholder: cleanText(element.getAttribute("placeholder") ?? element.getAttribute("data-placeholder")),
    name: cleanText(element.getAttribute("name") ?? element.id),
  };
}

export function describeField(element: FillableElement, adapter: SiteAdapter): FieldDescriptor {
  const semantics = describeFieldSemantics(element, adapter);
  return {
    ...semantics,
    autocomplete: isInputElement(element) ? element.autocomplete : "",
    controlType: elementControl(element, adapter),
    required: element.hasAttribute("required") || element.getAttribute("aria-required") === "true" || Boolean(element.closest("[class*='required' i], .ant-form-item-required, .semi-form-field-label-required")),
    disabled: "disabled" in element && Boolean(element.disabled),
    readOnly: "readOnly" in element && Boolean(element.readOnly),
    hasValue: isInputElement(element) || isTextareaElement(element)
      ? Boolean(element.value.trim())
      : isSelectElement(element)
        ? Boolean(element.value && element.selectedIndex > 0)
        : false,
    multiple: isSelectElement(element) && element.multiple,
    options: isSelectElement(element)
      ? Array.from(element.options).map((option) => ({ label: cleanText(option.text), value: option.value, disabled: option.disabled }))
      : [],
  };
}

export function optionLabel(element: HTMLInputElement): string {
  const ownerDocument = element.ownerDocument;
  if (element.id) {
    const label = ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(element.id, ownerDocument)}"]`);
    if (label) return cleanText(label.innerText || label.textContent);
  }
  const wrapping = element.closest("label");
  return cleanText((wrapping as HTMLElement | null)?.innerText || wrapping?.textContent || element.value);
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
  const repeatRoots = new Map(candidates.map((candidate) => [candidate, repeatRootFor(candidate)]));
  const hasRepeated = [...repeatRoots.values()].some(Boolean);
  const hasUnowned = [...repeatRoots.values()].some((root) => !root);
  if (hasRepeated && hasUnowned) return { elements: candidates, ambiguous: true };

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
  if (hasContainer && hasNoContainer) return { elements: candidates, ambiguous: true };
  const distinctContainers = new Set([...containers.values()].filter((container): container is Element => Boolean(container)));
  if (distinctContainers.size > 1 || (!hasContainer && candidates.length > 1)) {
    return { elements: candidates, ambiguous: true };
  }
  return { elements: candidates, ambiguous: false };
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
    .map((control) => {
      const semantics = describeFieldSemantics(control as FillableElement, adapter);
      return [
        nodeId(control),
        structuralToken(control.tagName),
        ...attributes(control, ["type", "id", "name", "role", "aria-label", "placeholder", "data-field", "data-index", "data-row-key"]),
        structuralToken(semantics.label),
        structuralToken(semantics.ariaLabel),
        structuralToken(semantics.placeholder),
        structuralToken(semantics.name),
      ].join(":");
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
  }));
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
): CachedTargetValidation {
  if (!sameTargetIdentity(cachedTarget, currentTarget)) return { valid: false, reason: "target_replaced" };
  const elements = Array.isArray(currentTarget) ? currentTarget : [currentTarget];
  if (elements.some((element) => !element.isConnected)) return { valid: false, reason: "target_disconnected" };
  if (elements.some((element) => !isEligible(element, adapter))) return { valid: false, reason: "target_ineligible" };
  if (elements.some((element) => isIgnoredByAdapter(element, adapter))) return { valid: false, reason: "target_ignored" };
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
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    if (Array.isArray(target)) {
      const requested = new Set(Array.isArray(value) ? value : [value]);
      if (!requested.size || [...requested].some((item) => !target.some((input) => input.value === item))) return false;
      if (target[0]?.type === "radio" && requested.size !== 1) return false;
      for (const input of target) {
        const checked = requested.has(input.value);
        setNativeProperty(input, "checked", checked);
        input.dispatchEvent(basicEventFor(input, "input"));
        input.dispatchEvent(basicEventFor(input, "change"));
      }
      return true;
    }
    if (isSelectElement(element)) {
      const requested = Array.isArray(value) ? value : [value];
      if (!requested.length || requested.some((item) => !Array.from(element.options).some((option) => !option.disabled && option.value === item))) return false;
      if (element.multiple) {
        for (const option of element.options) option.selected = requested.includes(option.value);
      } else {
        if (requested.length !== 1) return false;
        element.value = requested[0];
      }
    } else if (isInputElement(element)) {
      if (Array.isArray(value)) return false;
      setNativeProperty(element, "value", value);
    } else if (isTextareaElement(element)) {
      if (Array.isArray(value)) return false;
      setNativeProperty(element, "value", value);
    } else {
      if (Array.isArray(value)) return false;
      element.textContent = value;
    }
    const eventValue = Array.isArray(value) ? value.join(",") : value;
    element.focus();
    element.dispatchEvent(inputEventFor(element, eventValue));
    element.dispatchEvent(basicEventFor(element, "change"));
    element.dispatchEvent(basicEventFor(element, "blur"));
    return true;
  } catch {
    return false;
  }
}

export function restoreElement(snapshot: ElementSnapshot): boolean {
  const { element, value, checked } = snapshot;
  if (isInputElement(element) && checked !== undefined) {
    setNativeProperty(element, "checked", checked);
  } else if (isSelectElement(element)) element.value = value;
  else if (isInputElement(element)) {
    setNativeProperty(element, "value", value);
  } else if (isTextareaElement(element)) {
    setNativeProperty(element, "value", value);
  } else element.textContent = value;
  element.dispatchEvent(inputEventFor(element, value));
  element.dispatchEvent(basicEventFor(element, "change"));
  return true;
}

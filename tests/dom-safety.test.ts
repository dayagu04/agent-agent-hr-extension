import assert from "node:assert/strict";
import test from "node:test";

import {
  collectCandidates,
  collectNonFillableSemanticInventory,
  collectScanDocuments,
  deduplicateManualFields,
  describeField,
  describeSemanticField,
  duplicateSemanticCandidateIds,
  fillTarget,
  isEligible,
  RepeatBindingStore,
  registerFrameLoadListeners,
  repeatedMatchIdentity,
  repeatGroupStructureSignature,
  resolveRepeatGroupIdentity,
  scopeNamedChoiceGroup,
  selectHasCurrentValue,
  validateCachedFillTarget,
  type RepeatGroupIdentity,
} from "../src/dom-safety.ts";
import { matchDescriptor, semanticProfileKey, type FieldDecision, type FieldDescriptor } from "../src/field-matcher.ts";
import { getSiteAdapter, isIgnoredByAdapter } from "../src/site-adapters.ts";
import { EMPTY_PROFILE, type ProfileData } from "../src/types.ts";

class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly target: FakeElement | null;

  constructor(type: string, options?: { bubbles?: boolean; target?: FakeElement }) {
    this.type = type;
    this.bubbles = Boolean(options?.bubbles);
    this.target = options?.target ?? null;
  }
}

class FakeDocument {
  readonly location: { href: string };
  readonly documentElement = {};
  readonly defaultView: {
    getComputedStyle: (element: FakeElement) => { display: string; visibility: string };
    Event: typeof FakeEvent;
    InputEvent?: undefined;
    CSS: { escape: (value: string) => string };
  };
  frames: FakeFrame[] = [];
  controls: FakeElement[] = [];
  private listeners = new Map<string, Set<(event: FakeEvent) => void>>();

  constructor(url: string) {
    this.location = { href: url };
    this.defaultView = {
      getComputedStyle: (element) => ({ display: element.display, visibility: element.visibility }),
      Event: FakeEvent,
      CSS: { escape: (value) => value },
    };
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === "iframe") return this.frames;
    if (selector === "input, textarea, select, [contenteditable=true]") return this.controls;
    return [];
  }

  querySelector(): FakeElement | null {
    return null;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, target: FakeElement): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new FakeEvent(type, { target }));
  }
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly events: string[] = [];
  readonly attributes = new Map<string, string>();
  id = "";
  className = "";
  type = "text";
  name = "";
  autocomplete = "";
  disabled = false;
  readOnly = false;
  checked = false;
  multiple = false;
  selectedIndex = 0;
  options: Array<{ text: string; value: string; disabled: boolean; selected: boolean }> = [];
  textContent = "";
  innerText = "";
  isContentEditable = false;
  isConnected = true;
  effectiveDisabled = false;
  ignoredByAdapter = false;
  form: FakeElement | null = null;
  display = "block";
  visibility = "visible";
  width = 180;
  height = 36;
  previousElementSibling: FakeElement | null = null;
  nextElementSibling: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  childControls: FakeElement[] = [];
  proxy: FakeElement | null = null;
  valueReadCount = 0;
  private currentValue = "";

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get value(): string {
    this.valueReadCount += 1;
    return this.currentValue;
  }

  set value(value: string) {
    this.currentValue = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  closest(selector: string): FakeElement | null {
    if (this.proxy && /(label|upload|attachment)/i.test(selector)) return this.proxy;
    if (this.ignoredByAdapter && /(captcha|verify|password|sms|code)/i.test(selector)) return this;
    return null;
  }

  matches(selector = ""): boolean {
    if (selector === ":disabled") {
      if (this.disabled || this.effectiveDisabled) return true;
      let current = this.parentElement;
      while (current) {
        if (current.tagName === "FIELDSET" && current.hasAttribute("disabled")) return true;
        current = current.parentElement;
      }
    }
    return false;
  }

  querySelector(): FakeElement | null {
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === "input, textarea, select, [contenteditable=true], [role=combobox]"
      ? this.childControls
      : [];
  }

  scrollIntoView(): void {}

  focus(): void {}

  dispatchEvent(event: FakeEvent): boolean {
    this.events.push(event.type);
    return true;
  }
}

class FakeFrame extends FakeElement {
  title = "";
  child: FakeDocument | null = null;
  denyRead = false;
  contentDocumentReads = 0;

  constructor(ownerDocument: FakeDocument) {
    super("iframe", ownerDocument);
  }

  get contentDocument(): FakeDocument | null {
    this.contentDocumentReads += 1;
    if (this.denyRead) throw new Error("cross-origin");
    return this.child;
  }
}

function asDocument(document: FakeDocument): Document {
  return document as unknown as Document;
}

function asElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function asInput(element: FakeElement): HTMLInputElement {
  return element as unknown as HTMLInputElement;
}

test("a same-origin iframe field enters matching and is filled with iframe-realm events", () => {
  const root = new FakeDocument("https://jobs.bytedance.com/apply");
  const child = new FakeDocument("https://jobs.bytedance.com/apply/form");
  const frame = new FakeFrame(root);
  frame.title = "application form";
  frame.child = child;
  root.frames.push(frame);

  const nameInput = new FakeElement("input", child);
  nameInput.setAttribute("aria-label", "姓名");
  nameInput.setAttribute("required", "");
  child.controls.push(nameInput);

  const adapter = getSiteAdapter(root.location.href);
  const frameScan = collectScanDocuments(asDocument(root));
  assert.deepEqual(frameScan.documents, [root, child]);
  assert.deepEqual(frameScan.manualFrames, []);

  const candidates = frameScan.documents.flatMap((document) => collectCandidates(document, adapter));
  assert.deepEqual(candidates, [nameInput]);
  assert.equal(isEligible(asElement(nameInput), adapter), true);

  const descriptor = describeField(asElement(nameInput), adapter);
  const profile = { ...EMPTY_PROFILE, fullName: "脱敏测试用户" } as ProfileData;
  const decision = matchDescriptor(descriptor, profile);
  assert.equal(decision.action, "fill");
  assert.equal(decision.profileKey, "fullName");
  assert.equal(fillTarget(asElement(nameInput), decision.value ?? ""), true);
  assert.equal(nameInput.value, "脱敏测试用户");
  assert.deepEqual(nameInput.events, ["input", "change", "blur"]);
});

test("a cross-origin application iframe is not traversed and is reported manual", () => {
  const root = new FakeDocument("https://careers.example.test/job/1");
  const frame = new FakeFrame(root);
  frame.title = "Application form";
  frame.setAttribute("src", "https://ats.example.invalid/apply/1");
  frame.denyRead = true;
  root.frames.push(frame);

  const frameScan = collectScanDocuments(asDocument(root));
  assert.deepEqual(frameScan.documents, [root]);
  assert.deepEqual(frameScan.manualFrames, [{
    identity: "frame:0.0",
    label: "Application form",
    reason: "cross_origin_iframe",
    required: false,
  }]);
  assert.equal(frame.contentDocumentReads, 1);
});

test("frame load listeners cover every scanned same-origin document, including nested iframe reloads", () => {
  const root = new FakeDocument("https://jobs.bytedance.com/apply");
  const child = new FakeDocument("https://jobs.bytedance.com/apply/embedded");
  const nestedFrame = new FakeFrame(child);
  nestedFrame.title = "nested application section";
  let reloads = 0;
  const cleanups = registerFrameLoadListeners([asDocument(root), asDocument(child)], () => { reloads += 1; });

  child.emit("load", nestedFrame);
  assert.equal(reloads, 1);
  for (const cleanup of cleanups) cleanup();
  child.emit("load", nestedFrame);
  assert.equal(reloads, 1);
});

test("a hidden file input without a visible proxy is ignored, while a bounded outer-sibling upload button stays manual", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const hiddenFile = new FakeElement("input", document);
  hiddenFile.type = "file";
  hiddenFile.width = 0;
  hiddenFile.height = 0;
  hiddenFile.setAttribute("required", "");
  hiddenFile.setAttribute("aria-label", "上传简历");
  assert.equal(isEligible(asElement(hiddenFile), adapter), false);

  const wrapper = new FakeElement("div", document);
  const inner = new FakeElement("div", document);
  const visibleUploadButton = new FakeElement("button", document);
  visibleUploadButton.textContent = "上传简历附件";
  wrapper.children = [inner, visibleUploadButton];
  inner.children = [hiddenFile];
  hiddenFile.parentElement = inner;
  inner.parentElement = wrapper;
  inner.nextElementSibling = visibleUploadButton;
  visibleUploadButton.parentElement = wrapper;
  visibleUploadButton.previousElementSibling = inner;
  assert.equal(isEligible(asElement(hiddenFile), adapter), true);
  const descriptor = describeField(asElement(hiddenFile), adapter);
  assert.equal(descriptor.required, true);
  const decision = matchDescriptor(descriptor, EMPTY_PROFILE);
  assert.deepEqual(decision, {
    action: "manual",
    profileKey: null,
    confidence: 1,
    reason: "attachment_user_required",
    value: null,
  });
});

test("a reused repeat row invalidates binding and selection when its non-value structure changes", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const row = new FakeElement("div", document);
  row.setAttribute("data-row-key", "row-a");
  const company = new FakeElement("input", document);
  company.setAttribute("name", "experiences[0].company");
  company.setAttribute("aria-label", "公司名称");
  const role = new FakeElement("input", document);
  role.setAttribute("name", "experiences[0].role");
  role.setAttribute("aria-label", "职位名称");
  row.childControls = [company, role];

  const groupIds = new WeakMap<Element, RepeatGroupIdentity>();
  const structureNodeIds = new WeakMap<Element, string>();
  const bindings = new RepeatBindingStore();
  let sequence = 0;
  const allocate = () => `repeat-group-${++sequence}`;
  let nodeSequence = 0;
  const allocateNode = () => `node-${++nodeSequence}`;
  const adapter = getSiteAdapter(document.location.href);

  const firstSignature = repeatGroupStructureSignature(asElement(row), "experience", 1, adapter, structureNodeIds, allocateNode);
  assert.match(firstSignature, /^structure-v1-[0-9a-f]{16}$/);
  assert.equal(firstSignature.includes("row-a"), false);
  const first = resolveRepeatGroupIdentity(asElement(row), firstSignature, groupIds, bindings, allocate);
  bindings.set(first.groupKey, "experience-entry-2");
  const firstMatchId = repeatedMatchIdentity("field-1", first.groupKey);
  const selectedIds = new Set([firstMatchId]);

  company.value = "不参与签名的用户值";
  assert.equal(
    repeatGroupStructureSignature(asElement(row), "experience", 1, adapter, structureNodeIds, allocateNode),
    firstSignature,
    "input values must not be read into the structure signature",
  );

  row.setAttribute("data-row-key", "row-b");
  const reusedSignature = repeatGroupStructureSignature(asElement(row), "experience", 1, adapter, structureNodeIds, allocateNode);
  assert.notEqual(reusedSignature, firstSignature);
  const reused = resolveRepeatGroupIdentity(asElement(row), reusedSignature, groupIds, bindings, allocate);
  assert.deepEqual(reused, {
    groupKey: "repeat-group-2",
    targetEntryId: undefined,
    invalidatedGroupKey: first.groupKey,
  });
  assert.equal(bindings.has(first.groupKey), false);
  assert.equal(selectedIds.has(repeatedMatchIdentity("field-1", reused.groupKey)), false);

  const movedSignature = repeatGroupStructureSignature(asElement(row), "experience", 2, adapter, structureNodeIds, allocateNode);
  const moved = resolveRepeatGroupIdentity(asElement(row), movedSignature, groupIds, bindings, allocate);
  assert.equal(moved.targetEntryId, undefined);
  assert.equal(moved.invalidatedGroupKey, reused.groupKey);
});

test("an unchanged repeat row loses its binding after a new page scan epoch", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const row = new FakeElement("div", document);
  const groupIds = new WeakMap<Element, RepeatGroupIdentity>();
  const bindings = new RepeatBindingStore();
  let sequence = 0;
  const allocate = () => `repeat-group-${++sequence}`;

  const first = resolveRepeatGroupIdentity(asElement(row), "same-structure", groupIds, bindings, allocate);
  bindings.set(first.groupKey, "experience-entry-1");
  const bound = resolveRepeatGroupIdentity(asElement(row), "same-structure", groupIds, bindings, allocate);
  assert.equal(bound.targetEntryId, "experience-entry-1");
  const firstMatchId = repeatedMatchIdentity("field-1", first.groupKey, bindings.epoch);

  bindings.invalidate();
  const afterDynamicPageActivity = resolveRepeatGroupIdentity(asElement(row), "same-structure", groupIds, bindings, allocate);
  assert.equal(afterDynamicPageActivity.groupKey, first.groupKey);
  assert.equal(afterDynamicPageActivity.targetEntryId, undefined);
  assert.notEqual(repeatedMatchIdentity("field-1", first.groupKey, bindings.epoch), firstMatchId);
});

test("same-name checkboxes are scoped to one repeat row and filling a bound row does not touch its sibling", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const rowOne = new FakeElement("div", document);
  const rowTwo = new FakeElement("div", document);
  const makeChoice = (row: FakeElement, value: string) => {
    const input = new FakeElement("input", document);
    input.type = "checkbox";
    input.name = "current-role";
    input.value = value;
    input.parentElement = row;
    row.children.push(input);
    return input;
  };
  const rowOneYes = makeChoice(rowOne, "yes");
  const rowOneNo = makeChoice(rowOne, "no");
  const rowTwoYes = makeChoice(rowTwo, "yes");
  const rowTwoNo = makeChoice(rowTwo, "no");
  const candidates = [rowOneYes, rowOneNo, rowTwoYes, rowTwoNo].map(asInput);

  const scoped = scopeNamedChoiceGroup(asInput(rowOneYes), candidates, (candidate) => candidate.parentElement);
  assert.equal(scoped.ambiguous, false);
  assert.deepEqual(scoped.elements, [rowOneYes, rowOneNo]);

  const bindings = new RepeatBindingStore();
  const groupIds = new WeakMap<Element, RepeatGroupIdentity>();
  let sequence = 0;
  const allocate = () => `repeat-${++sequence}`;
  const first = resolveRepeatGroupIdentity(asElement(rowOne), "row-shape", groupIds, bindings, allocate);
  const second = resolveRepeatGroupIdentity(asElement(rowTwo), "row-shape", groupIds, bindings, allocate);
  bindings.set(first.groupKey, "entry-1");
  assert.equal(resolveRepeatGroupIdentity(asElement(rowOne), "row-shape", groupIds, bindings, allocate).targetEntryId, "entry-1");
  assert.equal(resolveRepeatGroupIdentity(asElement(rowTwo), "row-shape", groupIds, bindings, allocate).targetEntryId, undefined);

  assert.equal(fillTarget(scoped.elements, "yes"), true);
  assert.equal(rowOneYes.checked, true);
  assert.equal(rowOneNo.checked, false);
  assert.equal(rowTwoYes.checked, false);
  assert.equal(rowTwoNo.checked, false);
  assert.notEqual(first.groupKey, second.groupKey);
});

test("same-form radios spanning repeat roots are rejected before any fill", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const form = new FakeElement("form", document);
  const rowOne = new FakeElement("div", document);
  const rowTwo = new FakeElement("div", document);
  const createRadio = (row: FakeElement, value: string) => {
    const input = new FakeElement("input", document);
    input.type = "radio";
    input.name = "employment-status";
    input.value = value;
    input.form = form;
    input.parentElement = row;
    return input;
  };
  const candidates = [
    createRadio(rowOne, "current"),
    createRadio(rowOne, "former"),
    createRadio(rowTwo, "current"),
    createRadio(rowTwo, "former"),
  ].map(asInput);

  const policy = scopeNamedChoiceGroup(candidates[0], candidates, (candidate) => candidate.parentElement);
  assert.deepEqual(policy, {
    elements: candidates,
    ambiguous: true,
    reason: "radio_group_crosses_repeat_roots",
  });
});

test("a checked disabled or adapter-ignored member rejects the entire named choice group", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const rowOne = new FakeElement("div", document);
  const rowTwo = new FakeElement("div", document);
  const visible = new FakeElement("input", document);
  visible.type = "radio";
  visible.name = "shared-radio";
  visible.parentElement = rowOne;
  const externalChecked = new FakeElement("input", document);
  externalChecked.type = "radio";
  externalChecked.name = "shared-radio";
  externalChecked.parentElement = rowTwo;
  externalChecked.disabled = true;
  externalChecked.ignoredByAdapter = true;
  externalChecked.checked = true;
  assert.equal(isEligible(asElement(externalChecked), adapter), false);
  assert.equal(isIgnoredByAdapter(asElement(externalChecked), adapter), true);

  const candidates = [asInput(visible), asInput(externalChecked)];
  const policy = scopeNamedChoiceGroup(asInput(visible), candidates, (candidate) => candidate.parentElement);
  assert.deepEqual(policy, {
    elements: candidates,
    ambiguous: true,
    reason: "choice_group_has_existing_selection",
  });
});

test("mixed repeat ownership makes a same-name choice group ambiguous", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const row = new FakeElement("div", document);
  const owned = new FakeElement("input", document);
  const unowned = new FakeElement("input", document);
  owned.type = unowned.type = "radio";
  owned.name = unowned.name = "shared-name";
  const scoped = scopeNamedChoiceGroup(
    asInput(owned),
    [asInput(owned), asInput(unowned)],
    (candidate) => candidate === asInput(owned) ? asElement(row) : null,
  );
  assert.equal(scoped.ambiguous, true);
  assert.deepEqual(scoped.elements, [owned, unowned]);
});

test("cached targets are rejected after user value, disable, removal, or semantic change", () => {
  const document = new FakeDocument("https://jobs.bytedance.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const input = new FakeElement("input", document);
  input.setAttribute("aria-label", "姓名");
  const cachedDescriptor = describeField(asElement(input), adapter);
  const cachedTarget = asElement(input);

  assert.deepEqual(
    validateCachedFillTarget(cachedTarget, cachedTarget, cachedDescriptor, describeField(cachedTarget, adapter), adapter),
    { valid: true },
  );

  input.value = "页面刚写入的值";
  assert.deepEqual(
    validateCachedFillTarget(cachedTarget, cachedTarget, cachedDescriptor, describeField(cachedTarget, adapter), adapter),
    { valid: false, reason: "target_ineligible" },
  );
  input.value = "";
  input.disabled = true;
  assert.deepEqual(
    validateCachedFillTarget(cachedTarget, cachedTarget, cachedDescriptor, describeField(cachedTarget, adapter), adapter),
    { valid: false, reason: "target_ineligible" },
  );
  input.disabled = false;
  input.isConnected = false;
  assert.deepEqual(
    validateCachedFillTarget(cachedTarget, cachedTarget, cachedDescriptor, describeField(cachedTarget, adapter), adapter),
    { valid: false, reason: "target_disconnected" },
  );
  input.isConnected = true;
  input.setAttribute("aria-label", "联系电话");
  assert.deepEqual(
    validateCachedFillTarget(cachedTarget, cachedTarget, cachedDescriptor, describeField(cachedTarget, adapter), adapter),
    { valid: false, reason: "semantics_changed" },
  );
});

test("cached radio groups are rejected when the page already selected an option", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const first = new FakeElement("input", document);
  const second = new FakeElement("input", document);
  first.type = second.type = "radio";
  first.name = second.name = "gender";
  first.value = "female";
  second.value = "male";
  const target = [asInput(first), asInput(second)];
  const descriptor = describeField(asElement(first), adapter);
  descriptor.controlType = "radio";
  descriptor.options = [
    { label: "女", value: "female", disabled: false },
    { label: "男", value: "male", disabled: false },
  ];
  second.checked = true;
  assert.deepEqual(
    validateCachedFillTarget(target, target, descriptor, { ...descriptor }, adapter),
    { valid: false, reason: "choice_already_selected" },
  );
});

test("a non-empty first select option is already filled, while an empty placeholder remains eligible", () => {
  const document = new FakeDocument("https://jobs.bytedance.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const select = new FakeElement("select", document);
  select.setAttribute("aria-label", "学历");
  select.options = [{ text: "请选择", value: "", disabled: false, selected: true }];
  select.value = "";
  select.selectedIndex = 0;
  const blankDescriptor = describeField(asElement(select), adapter);
  assert.equal(selectHasCurrentValue(asElement(select) as unknown as HTMLSelectElement), false);
  assert.equal(isEligible(asElement(select), adapter), true);
  assert.equal(blankDescriptor.hasValue, false);

  select.options = [{ text: "本科", value: "bachelor", disabled: false, selected: true }];
  select.value = "bachelor";
  select.selectedIndex = 0;
  const filledDescriptor = describeField(asElement(select), adapter);
  assert.equal(selectHasCurrentValue(asElement(select) as unknown as HTMLSelectElement), true);
  assert.equal(isEligible(asElement(select), adapter), false);
  assert.equal(filledDescriptor.hasValue, true);
  assert.equal(matchDescriptor(filledDescriptor, { ...EMPTY_PROFILE, degree: "本科" } as ProfileData).reason, "already_filled");
  assert.deepEqual(
    validateCachedFillTarget(asElement(select), asElement(select), blankDescriptor, filledDescriptor, adapter),
    { valid: false, reason: "target_ineligible" },
  );
});

test("effective fieldset and ARIA disabled or readonly state fail closed", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);

  const fieldset = new FakeElement("fieldset", document);
  fieldset.setAttribute("disabled", "");
  const fieldsetInput = new FakeElement("input", document);
  fieldsetInput.parentElement = fieldset;
  assert.equal(isEligible(asElement(fieldsetInput), adapter), false);
  assert.equal(describeField(asElement(fieldsetInput), adapter).disabled, true);

  const disabledContainer = new FakeElement("div", document);
  disabledContainer.setAttribute("aria-disabled", "true");
  const ariaDisabledInput = new FakeElement("input", document);
  ariaDisabledInput.parentElement = disabledContainer;
  assert.equal(isEligible(asElement(ariaDisabledInput), adapter), false);
  assert.equal(describeField(asElement(ariaDisabledInput), adapter).disabled, true);

  const readonlyContainer = new FakeElement("div", document);
  readonlyContainer.setAttribute("aria-readonly", "true");
  const ariaReadonlyInput = new FakeElement("input", document);
  ariaReadonlyInput.parentElement = readonlyContainer;
  assert.equal(isEligible(asElement(ariaReadonlyInput), adapter), false);
  assert.equal(describeField(asElement(ariaReadonlyInput), adapter).readOnly, true);
});

test("semantic inventory makes a filled missed-repeat row a sentinel for an empty scalar twin", () => {
  const document = new FakeDocument("https://careers.example.test/apply");
  const adapter = getSiteAdapter(document.location.href);
  const filled = new FakeElement("input", document);
  const empty = new FakeElement("input", document);
  filled.setAttribute("aria-label", "学校名称");
  empty.setAttribute("aria-label", "毕业院校");
  filled.value = "不应进入描述符的示例值";

  assert.equal(isEligible(asElement(filled), adapter), false);
  assert.equal(isEligible(asElement(empty), adapter), true);
  filled.valueReadCount = 0;
  const semanticOnlyDescriptor = describeSemanticField(asElement(filled), adapter);
  assert.ok(semanticOnlyDescriptor);
  assert.equal(filled.valueReadCount, 0, "semantic inventory must not read the current value");
  const inventory = collectNonFillableSemanticInventory([asElement(filled), asElement(empty)], adapter);
  assert.deepEqual(inventory.map(({ element }) => element), [filled]);
  const sentinelDescriptor = inventory[0].descriptor;
  assert.equal(JSON.stringify(sentinelDescriptor).includes("不应进入描述符的示例值"), false);

  const fillDescriptor = describeField(asElement(empty), adapter);
  const fillDecision = matchDescriptor(fillDescriptor, { ...EMPTY_PROFILE, school: "示例大学" } as ProfileData);
  const sentinelKey = semanticProfileKey(sentinelDescriptor);
  assert.equal(fillDecision.action, "fill");
  assert.equal(sentinelKey, "school");
  if (!fillDecision.profileKey || !sentinelKey) throw new Error("missing school semantic");

  const unsafe = duplicateSemanticCandidateIds([
    { identity: "filled-missed-row", ownerDocument: asDocument(document), profileKey: sentinelKey, repeated: false },
    { identity: "empty-missed-row", ownerDocument: asDocument(document), profileKey: fillDecision.profileKey, repeated: false },
  ]);
  const automaticFills = fillDecision.action === "fill" && !unsafe.has("empty-missed-row") ? 1 : 0;
  assert.deepEqual([...unsafe].sort(), ["empty-missed-row", "filled-missed-row"]);
  assert.equal(automaticFills, 0);
});

test("a filled recognized repeat sentinel blocks an empty missed scalar fallback", () => {
  const document = new FakeDocument("https://careers.example.test/apply");
  const adapter = getSiteAdapter(document.location.href);
  const filledRepeat = new FakeElement("input", document);
  const emptyScalar = new FakeElement("input", document);
  filledRepeat.setAttribute("aria-label", "学校名称");
  emptyScalar.setAttribute("aria-label", "毕业院校");
  filledRepeat.value = "已存在的脱敏学校";

  const inventory = collectNonFillableSemanticInventory([asElement(filledRepeat), asElement(emptyScalar)], adapter);
  assert.deepEqual(inventory.map(({ element }) => element), [filledRepeat]);
  const repeatDescriptor = inventory[0].descriptor;
  repeatDescriptor.repeated = {
    groupKey: "education-row-1",
    groupLabel: "教育经历第 1 行",
    kind: "education",
    field: "school",
    targetEntryId: "education-1",
  };
  const repeatKey = semanticProfileKey(repeatDescriptor);
  const scalarDescriptor = describeField(asElement(emptyScalar), adapter);
  const scalarDecision = matchDescriptor(scalarDescriptor, { ...EMPTY_PROFILE, school: "示例大学" } as ProfileData);
  assert.equal(isEligible(asElement(filledRepeat), adapter), false);
  assert.equal(repeatKey, "school");
  assert.equal(scalarDecision.action, "fill");
  if (!repeatKey || !scalarDecision.profileKey) throw new Error("missing school semantic");

  const unsafe = duplicateSemanticCandidateIds([
    { identity: "filled-recognized-repeat", ownerDocument: asDocument(document), profileKey: repeatKey, repeated: true },
    { identity: "empty-scalar-fallback", ownerDocument: asDocument(document), profileKey: scalarDecision.profileKey, repeated: false },
  ]);
  assert.deepEqual([...unsafe].sort(), ["empty-scalar-fallback", "filled-recognized-repeat"]);
  assert.equal(scalarDecision.action === "fill" && !unsafe.has("empty-scalar-fallback"), false);
});

test("disabled and readonly semantic sentinels each block an empty scalar twin", () => {
  for (const state of ["disabled", "readonly"] as const) {
    const document = new FakeDocument(`https://careers.example.test/apply?state=${state}`);
    const adapter = getSiteAdapter(document.location.href);
    const sentinel = new FakeElement("input", document);
    const empty = new FakeElement("input", document);
    sentinel.setAttribute("aria-label", "联系邮箱");
    empty.setAttribute("aria-label", "电子邮箱");
    if (state === "disabled") sentinel.disabled = true;
    else sentinel.readOnly = true;

    assert.equal(isEligible(asElement(sentinel), adapter), false, state);
    assert.equal(isEligible(asElement(empty), adapter), true, state);
    const inventory = collectNonFillableSemanticInventory([asElement(sentinel), asElement(empty)], adapter);
    assert.deepEqual(inventory.map(({ element }) => element), [sentinel], state);
    const sentinelDescriptor = inventory[0].descriptor;
    const sentinelKey = semanticProfileKey(sentinelDescriptor);
    const fillDecision = matchDescriptor(
      describeField(asElement(empty), adapter),
      { ...EMPTY_PROFILE, email: "masked@example.test" } as ProfileData,
    );
    assert.equal(sentinelKey, "email", state);
    assert.equal(fillDecision.action, "fill", state);
    if (!sentinelKey || !fillDecision.profileKey) throw new Error(`missing email semantic for ${state}`);

    const unsafe = duplicateSemanticCandidateIds([
      { identity: `${state}-sentinel`, ownerDocument: asDocument(document), profileKey: sentinelKey, repeated: false },
      { identity: `${state}-empty`, ownerDocument: asDocument(document), profileKey: fillDecision.profileKey, repeated: false },
    ]);
    assert.deepEqual([...unsafe].sort(), [`${state}-empty`, `${state}-sentinel`].sort());
    assert.equal(fillDecision.action === "fill" && !unsafe.has(`${state}-empty`), false, state);
  }
});

test("semantic inventory rejects sensitive, hidden, and undescribed controls", () => {
  const document = new FakeDocument("https://careers.example.test/apply");
  const adapter = getSiteAdapter(document.location.href);
  for (const type of ["password", "hidden", "file"] as const) {
    const control = new FakeElement("input", document);
    control.type = type;
    control.setAttribute("aria-label", type === "password" ? "密码" : "附件");
    assert.equal(describeSemanticField(asElement(control), adapter), null, type);
    assert.deepEqual(collectNonFillableSemanticInventory([asElement(control)], adapter), [], type);
  }
  const undescribed = new FakeElement("input", document);
  assert.equal(describeSemanticField(asElement(undescribed), adapter), null);
  assert.deepEqual(collectNonFillableSemanticInventory([asElement(undescribed)], adapter), []);
});

test("duplicate scalar school and experience semantics without repeat roots produce zero automatic fills", () => {
  const document = new FakeDocument("https://careers.example.test/apply");
  const adapter = getSiteAdapter(document.location.href);
  const profile = {
    ...EMPTY_PROFILE,
    school: "示例大学",
    experience: "脱敏工作经历",
  } as ProfileData;
  const cases: Array<{ id: string; descriptor: FieldDescriptor; decision: FieldDecision }> = [];
  for (const [id, tagName, label] of [
    ["school-a", "input", "学校名称"],
    ["school-b", "input", "毕业院校"],
    ["experience-a", "textarea", "工作经历"],
    ["experience-b", "textarea", "实习经历"],
  ] as const) {
    const element = new FakeElement(tagName, document);
    element.setAttribute("aria-label", label);
    const descriptor = describeField(asElement(element), adapter);
    const decision = matchDescriptor(descriptor, profile);
    assert.equal(decision.action, "fill", `${id} precondition`);
    cases.push({ id, descriptor, decision });
  }
  const unsafe = duplicateSemanticCandidateIds(cases.map(({ id, descriptor, decision }) => {
    if (!decision.profileKey) throw new Error(`missing profile key for ${id}`);
    return {
      identity: id,
      ownerDocument: asDocument(document),
      profileKey: decision.profileKey,
      repeated: Boolean(descriptor.repeated),
    };
  }));
  assert.deepEqual([...unsafe].sort(), cases.map(({ id }) => id).sort());
  const unexpectedFills = cases.filter(({ id, decision }) => decision.action === "fill" && !unsafe.has(id));
  assert.equal(unexpectedFills.length, 0);
});

test("one recognized repeat field and one scalar fallback with the same key both fail closed", () => {
  const document = new FakeDocument("https://careers.example.test/apply");
  const adapter = getSiteAdapter(document.location.href);
  const profile = {
    ...EMPTY_PROFILE,
    school: "示例大学",
    educationEntries: [{
      id: "education-1",
      school: "示例大学",
      major: "示例专业",
      degree: "本科",
      startDate: "2020-09",
      endDate: "2024-06",
      gpa: "",
      description: "",
    }],
  } as ProfileData;
  const recognized: FieldDescriptor = {
    label: "学校名称",
    controlType: "text",
    repeated: {
      groupKey: "education-row-1",
      groupLabel: "教育经历第 1 行",
      kind: "education",
      field: "school",
      targetEntryId: "education-1",
    },
  };
  const fallback: FieldDescriptor = { label: "毕业院校", controlType: "text" };
  const recognizedDecision = matchDescriptor(recognized, profile);
  const fallbackDecision = matchDescriptor(fallback, profile);
  assert.equal(recognizedDecision.action, "fill");
  assert.equal(fallbackDecision.action, "fill");
  if (!recognizedDecision.profileKey || !fallbackDecision.profileKey) throw new Error("missing profile key");
  const unsafe = duplicateSemanticCandidateIds([
    { identity: "recognized", ownerDocument: asDocument(document), profileKey: recognizedDecision.profileKey, repeated: true },
    { identity: "fallback", ownerDocument: asDocument(document), profileKey: fallbackDecision.profileKey, repeated: false },
  ]);
  assert.deepEqual([...unsafe].sort(), ["fallback", "recognized"]);
});

test("manual items with the same label stay distinct across document, group, and element identities", () => {
  const items = deduplicateManualFields([
    { identity: "document-0:repeat-1:field-1", label: "公司名称", reason: "repeated_group_unbound", required: true },
    { identity: "document-0:repeat-2:field-2", label: "公司名称", reason: "repeated_group_unbound", required: true },
    { identity: "document-1:repeat-1:field-1", label: "公司名称", reason: "repeated_group_unbound", required: true },
    { identity: "document-0:repeat-1:field-1", label: "公司名称", reason: "repeated_group_unbound", required: true },
  ]);
  assert.equal(items.length, 3);
});

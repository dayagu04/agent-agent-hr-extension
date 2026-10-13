import assert from "node:assert/strict";
import test from "node:test";

import {
  collectCandidates,
  collectSemanticInventory,
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
  resolveDuplicateSemanticCandidates,
  resolveRepeatGroupIdentity,
  restoreElement,
  scopeNamedChoiceGroup,
  selectHasCurrentValue,
  snapshotTarget,
  targetRetainsPlannedValue,
  validateCachedFillTarget,
  writeAndVerifyTarget,
  type RepeatGroupIdentity,
} from "../src/dom-safety.ts";
import { matchDescriptor, semanticProfileKey, type FieldDecision, type FieldDescriptor } from "../src/field-matcher.ts";
import { getSiteAdapter, isIgnoredByAdapter } from "../src/site-adapters.ts";
import { EMPTY_PROFILE, type ProfileData } from "../src/types.ts";
import { fillSequentially } from "../src/sequential-fill.ts";
import { buildResumeSections } from "../src/resume-data.ts";

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

class FakeTextNode {
  readonly nodeType = 3;
  readonly textContent: string;

  constructor(textContent: string) {
    this.textContent = textContent;
  }
}

class FakeElement {
  readonly nodeType = 1;
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
  multiple = false;
  selectedIndex = 0;
  options: Array<{ text: string; value: string; disabled: boolean; selected: boolean }> = [];
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
  childNodes: Array<FakeElement | FakeTextNode> = [];
  proxy: FakeElement | null = null;
  valueReadCount = 0;
  checkedWriteCount = 0;
  textContentReadCount = 0;
  innerTextReadCount = 0;
  throwOnValueRead = false;
  throwOnTextContentRead = false;
  throwOnInnerTextRead = false;
  private currentValue = "";
  private currentChecked = false;
  private currentTextContent = "";
  private currentInnerText = "";

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get value(): string {
    this.valueReadCount += 1;
    if (this.throwOnValueRead) throw new Error("value getter must not be read");
    return this.currentValue;
  }

  set value(value: string) {
    this.currentValue = value;
  }

  get checked(): boolean {
    return this.currentChecked;
  }

  set checked(value: boolean) {
    this.checkedWriteCount += 1;
    this.currentChecked = value;
  }

  get textContent(): string {
    this.textContentReadCount += 1;
    if (this.throwOnTextContentRead) throw new Error("textContent getter must not be read");
    return this.currentTextContent;
  }

  set textContent(value: string) {
    this.currentTextContent = value;
  }

  get innerText(): string {
    this.innerTextReadCount += 1;
    if (this.throwOnInnerTextRead) throw new Error("innerText getter must not be read");
    return this.currentInnerText;
  }

  set innerText(value: string) {
    this.currentInnerText = value;
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
    return selector.split(",").some((part) => {
      const simple = part.trim();
      if (simple === "input") return this.tagName === "INPUT";
      if (simple === "textarea") return this.tagName === "TEXTAREA";
      if (simple === "select") return this.tagName === "SELECT";
      if (simple.startsWith("[contenteditable]")) return this.isContentEditable;
      if (/^\[role=['\"]?combobox/i.test(simple)) return this.getAttribute("role") === "combobox";
      if (/^\[role=['\"]?textbox/i.test(simple)) return this.getAttribute("role") === "textbox";
      if (simple.startsWith(".")) return this.className.split(/\s+/).includes(simple.slice(1));
      return false;
    });
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

  compareDocumentPosition(other: FakeElement): number {
    return this.ownerDocument.controls.indexOf(this) < this.ownerDocument.controls.indexOf(other) ? 4 : 2;
  }

  focus(): void {}

  blur(): void { this.events.push("blur", "focusout"); }

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
  assert.equal(targetRetainsPlannedValue(asElement(nameInput), "脱敏测试用户"), true);
  assert.deepEqual(nameInput.events, ["input", "change", "blur", "focusout"]);
});

test("write attempt is not accepted as a retained value after the page reverts or replaces a control", () => {
  const document = new FakeDocument("https://careers.example.test/apply");
  const input = new FakeElement("input", document);
  const target = asElement(input);
  assert.equal(fillTarget(target, "test@example.invalid"), true);
  assert.equal(targetRetainsPlannedValue(target, "test@example.invalid"), true);
  input.value = "";
  assert.equal(targetRetainsPlannedValue(target, "test@example.invalid"), false);
  input.value = "test@example.invalid";
  input.isConnected = false;
  assert.equal(targetRetainsPlannedValue(target, "test@example.invalid"), false);
});

test("one-click write verifies retention and compensates failed blank or overwritten controls", async () => {
  const document = new FakeDocument("https://careers.example.test/apply");
  const blank = new FakeElement("input", document);
  const blankResult = await writeAndVerifyTarget(asInput(blank), "planned", async () => {
    if (blank.value === "planned") blank.value = "page-reverted";
  });
  assert.equal(blankResult.attempted, true);
  assert.equal(blankResult.outcome, "cleared");
  assert.equal(blank.value, "");

  const existing = new FakeElement("input", document);
  existing.value = "prior";
  const existingResult = await writeAndVerifyTarget(asInput(existing), "planned", async () => {
    if (existing.value === "planned") existing.value = "page-reverted";
  });
  assert.equal(existingResult.outcome, "restored");
  assert.equal(existing.value, "prior");

  const stable = new FakeElement("input", document);
  const retained = await writeAndVerifyTarget(asInput(stable), "planned", async () => undefined);
  assert.equal(retained.outcome, "retained");
  assert.equal(stable.value, "planned");

  const controlled = new FakeElement("input", document);
  let committed = "";
  controlled.focus = () => { controlled.value = committed; };
  controlled.blur = () => { committed = controlled.value; controlled.events.push("focusout"); };
  const committedResult = await writeAndVerifyTarget(asInput(controlled), "edited", async () => { controlled.value = committed; });
  assert.equal(committedResult.outcome, "retained");
  assert.equal(committed, "edited");

  const lateReset = new FakeElement("input", document);
  let ticks = 0;
  const lateResult = await writeAndVerifyTarget(asInput(lateReset), "planned", async () => {
    if (++ticks === 2) lateReset.value = "";
  });
  assert.equal(lateResult.outcome, "cleared");

  const replaced = new FakeElement("input", document);
  const reverted = await writeAndVerifyTarget(asInput(replaced), "planned", async () => {
    replaced.isConnected = false;
  });
  assert.equal(reverted.outcome, "reverted");
  const savedObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} disconnect() {} } as unknown as typeof MutationObserver;
  try {
    const name = new FakeElement("input", document); name.id = "name"; name.setAttribute("aria-label", "姓名");
    const email = new FakeElement("input", document); email.id = "email"; email.type = "email"; email.setAttribute("aria-label", "邮箱");
    const secret = new FakeElement("input", document); secret.id = "secret"; secret.type = "password"; secret.throwOnValueRead = true;
    // Formily repeats field IDs across cards; neither record may disappear from the walk.
    const school1 = new FakeElement("input", document); school1.id = "formily-item-school"; school1.setAttribute("aria-label", "学校名称");
    const school2 = new FakeElement("input", document); school2.id = "formily-item-school"; school2.setAttribute("aria-label", "学校名称");
    const educationRoot = new FakeElement("div", document);
    const card1 = new FakeElement("div", document), card2 = new FakeElement("div", document);
    educationRoot.children = [card1, card2]; card1.parentElement = card2.parentElement = educationRoot;
    card1.children = [school1]; card2.children = [school2]; school1.parentElement = card1; school2.parentElement = card2;
    document.controls = [name, email, secret, school1, school2];
    const result = await fillSequentially(asDocument(document), getSiteAdapter(document.location.href), buildResumeSections({
      basic: { legal_name_zh: "示例姓名", contact_email: "person@example.invalid" },
      educations: [{ recordId: "education1", school_name: "示例大学一" }, { recordId: "education2", school_name: "示例大学二" }],
    }), { cancelled: () => false, onProgress: () => undefined, onField: () => undefined });
    assert.equal(name.value, "示例姓名");
    assert.equal(email.value, "person@example.invalid");
    assert.equal(school1.value, "示例大学一");
    assert.equal(school2.value, "示例大学二");
    assert.equal(result.progress.filled, 4);
    assert.equal(result.undo.length, 4);
    assert.equal(secret.valueReadCount, 0);
  } finally { globalThis.MutationObserver = savedObserver; }
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

test("choice eligibility is evaluated only after the current repeat scope is fixed", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const disabledRow = new FakeElement("div", document);
  const writableRow = new FakeElement("div", document);
  const makeChoice = (row: FakeElement, disabled: boolean, value: string) => {
    const input = new FakeElement("input", document);
    input.type = "checkbox";
    input.name = "same-choice-name";
    input.value = value;
    input.disabled = disabled;
    input.parentElement = row;
    return input;
  };
  const disabledChoices = [
    makeChoice(disabledRow, true, "disabled-a"),
    makeChoice(disabledRow, true, "disabled-b"),
  ];
  const writableChoices = [
    makeChoice(writableRow, false, "writable-a"),
    makeChoice(writableRow, false, "writable-b"),
  ];
  const all = [...disabledChoices, ...writableChoices].map(asInput);
  const repeatRootFor = (candidate: HTMLInputElement) => candidate.parentElement;

  const firstScope = scopeNamedChoiceGroup(asInput(disabledChoices[0]), all, repeatRootFor);
  assert.deepEqual(firstScope.elements, disabledChoices);
  assert.deepEqual(firstScope.elements.filter((candidate) => isEligible(candidate, adapter)), []);

  const secondScope = scopeNamedChoiceGroup(asInput(writableChoices[0]), all, repeatRootFor);
  assert.deepEqual(secondScope.elements, writableChoices);
  assert.deepEqual(secondScope.elements.filter((candidate) => isEligible(candidate, adapter)), writableChoices);
});

test("choice option values do not look filled while checked groups stay fail closed", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const cases = [
    {
      type: "radio" as const,
      name: "gender",
      label: "性别",
      values: ["m", "f"],
      options: [{ label: "男", value: "m" }, { label: "女", value: "f" }],
      profile: { ...EMPTY_PROFILE, gender: "女" },
      expectedValue: "f",
    },
    {
      type: "checkbox" as const,
      name: "skills",
      label: "技能",
      values: ["py", "fa"],
      options: [{ label: "Python", value: "py" }, { label: "FastAPI", value: "fa" }],
      profile: { ...EMPTY_PROFILE, skills: "Python、FastAPI" },
      expectedValue: ["py", "fa"],
    },
  ];

  for (const choiceCase of cases) {
    const container = new FakeElement("fieldset", document);
    const choices = choiceCase.values.map((value) => {
      const input = new FakeElement("input", document);
      input.type = choiceCase.type;
      input.name = choiceCase.name;
      input.value = value;
      input.setAttribute("aria-label", choiceCase.label);
      input.throwOnValueRead = true;
      input.parentElement = container;
      return input;
    });
    const inputs = choices.map(asInput);
    const unselectedScope = scopeNamedChoiceGroup(inputs[0], inputs, () => null, () => asElement(container));
    assert.equal(unselectedScope.ambiguous, false, choiceCase.type);
    assert.equal(isEligible(asElement(choices[0]), adapter), true, choiceCase.type);

    const descriptor = describeField(asElement(choices[0]), adapter);
    assert.equal(descriptor.hasValue, false, `${choiceCase.type} fixed option value is not user state`);
    assert.equal(choices[0].valueReadCount, 0, `${choiceCase.type} descriptor stays value blind`);
    descriptor.options = choiceCase.options;
    descriptor.controlType = choiceCase.type;
    descriptor.multiple = choiceCase.type === "checkbox";
    const decision = matchDescriptor(descriptor, choiceCase.profile);
    assert.equal(decision.action, "fill", choiceCase.type);
    assert.deepEqual(decision.value, choiceCase.expectedValue, choiceCase.type);
    assert.equal(choices[0].valueReadCount, 0, `${choiceCase.type} matching uses sanitized options`);

    if (decision.value === null) throw new Error(`missing ${choiceCase.type} decision value`);
    for (const choice of choices) choice.throwOnValueRead = false;
    assert.equal(fillTarget(inputs, decision.value), true, `${choiceCase.type} unique group fills`);
    assert.deepEqual(
      choices.map((choice) => choice.checked),
      choiceCase.type === "radio" ? [false, true] : [true, true],
      choiceCase.type,
    );
    const valueReadsAfterWrite = choices.map((choice) => choice.valueReadCount);
    const checkedScope = scopeNamedChoiceGroup(inputs[0], inputs, () => null, () => asElement(container));
    assert.deepEqual(checkedScope, {
      elements: inputs,
      ambiguous: true,
      reason: "choice_group_has_existing_selection",
    }, choiceCase.type);
    const checkedDescriptor = describeField(asElement(choices[1]), adapter);
    assert.equal(checkedDescriptor.hasValue, true, `${choiceCase.type} checked state is user state`);
    assert.deepEqual(
      choices.map((choice) => choice.valueReadCount),
      valueReadsAfterWrite,
      `${choiceCase.type} checked detection stays value blind`,
    );
  }
});

test("duplicate native choice values fail before any checked or selected write", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  for (const type of ["radio", "checkbox"] as const) {
    const makeChoice = (label: string) => {
      const input = new FakeElement("input", document);
      input.type = type;
      input.name = `${type}-skills`;
      input.value = "on";
      input.setAttribute("aria-label", label);
      return input;
    };
    const python = makeChoice("Python");
    const java = makeChoice("Java");
    const requested = type === "radio" ? "on" : ["on"];

    assert.equal(fillTarget([asInput(python), asInput(java)], requested), false, type);
    assert.equal(python.checked, false, `${type} Python remains clear`);
    assert.equal(java.checked, false, `${type} Java remains clear`);
    assert.equal(python.checkedWriteCount, 0, `${type} Python zero writes`);
    assert.equal(java.checkedWriteCount, 0, `${type} Java zero writes`);
    assert.deepEqual(python.events, [], `${type} Python zero events`);
    assert.deepEqual(java.events, [], `${type} Java zero events`);
  }

  for (const multiple of [false, true]) {
    let pythonSelected = false;
    let javaSelected = false;
    let pythonWrites = 0;
    let javaWrites = 0;
    const select = new FakeElement("select", document);
    select.multiple = multiple;
    select.value = "";
    select.options = [
      {
        text: "Python",
        value: "on",
        disabled: false,
        get selected() { return pythonSelected; },
        set selected(value: boolean) { pythonWrites += 1; pythonSelected = value; },
      },
      {
        text: "Java",
        value: "on",
        disabled: false,
        get selected() { return javaSelected; },
        set selected(value: boolean) { javaWrites += 1; javaSelected = value; },
      },
    ];
    const requested = multiple ? ["on"] : "on";

    assert.equal(fillTarget(asElement(select), requested), false, multiple ? "multi-select" : "single-select");
    assert.equal(pythonSelected, false);
    assert.equal(javaSelected, false);
    assert.equal(pythonWrites, 0, "Python option zero writes");
    assert.equal(javaWrites, 0, "Java option zero writes");
    assert.deepEqual(select.events, [], "select zero events");
  }
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

test("explicit overwrite applies only to unchanged ordinary text controls", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const input = new FakeElement("input", document);
  input.setAttribute("aria-label", "姓名");
  input.value = "原有文字";
  const target = asElement(input);
  assert.equal(isEligible(target, adapter), false);
  assert.equal(isEligible(target, adapter, true), true);
  const original = snapshotTarget(target);
  const descriptor = describeField(target, adapter);
  assert.equal(
    matchDescriptor(descriptor, { ...EMPTY_PROFILE, fullName: "新文字" } as ProfileData).reason,
    "already_filled",
  );
  assert.equal(
    matchDescriptor(descriptor, { ...EMPTY_PROFILE, fullName: "新文字" } as ProfileData, undefined, { allowExistingText: true }).action,
    "fill",
  );
  const options = { allowOverwriteExistingText: true, expectedSnapshots: original };
  assert.deepEqual(validateCachedFillTarget(target, target, descriptor, describeField(target, adapter), adapter, options), { valid: true });
  assert.equal(fillTarget(target, "新文字"), true);
  assert.equal(input.value, "新文字");
  assert.equal(restoreElement(original[0]), true);
  assert.equal(input.value, "原有文字");
  assert.deepEqual(validateCachedFillTarget(target, target, descriptor, describeField(target, adapter), adapter),
    { valid: false, reason: "target_ineligible" });
  input.value = "用户刚修改";
  assert.deepEqual(validateCachedFillTarget(target, target, descriptor, describeField(target, adapter), adapter, options),
    { valid: false, reason: "value_changed" });
  input.value = "";
  assert.deepEqual(validateCachedFillTarget(target, target, descriptor, describeField(target, adapter), adapter, options),
    { valid: false, reason: "value_state_changed" });
  for (const type of ["password", "file", "checkbox", "radio"]) {
    input.type = type;
    input.value = "原有文字";
    assert.equal(isEligible(target, adapter, true), isEligible(target, adapter), `overwrite must not change ${type} eligibility`);
  }
  input.type = "text";
  input.readOnly = true;
  assert.equal(isEligible(target, adapter, true), false);
});

test("cached ignored targets are rejected before their value getter is read", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const ignored = new FakeElement("input", document);
  ignored.ignoredByAdapter = true;
  ignored.throwOnValueRead = true;
  const descriptor: FieldDescriptor = { label: "短信验证码", controlType: "text" };
  assert.deepEqual(
    validateCachedFillTarget(asElement(ignored), asElement(ignored), descriptor, descriptor, adapter),
    { valid: false, reason: "target_ignored" },
  );
  assert.equal(ignored.valueReadCount, 0);
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
  assert.equal(
    matchDescriptor({ ...filledDescriptor, controlType: "select" }, { ...EMPTY_PROFILE, degree: "本科" } as ProfileData, undefined, { allowExistingText: true }).reason,
    "already_filled",
  );
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
  const inventory = collectSemanticInventory([asElement(filled), asElement(empty)], adapter);
  assert.deepEqual(inventory.map(({ element }) => element), [filled, empty]);
  assert.equal(filled.valueReadCount, 0, "full inventory must not use eligibility value reads");
  const sentinelDescriptor = inventory.find(({ element }) => element === asElement(filled))?.descriptor;
  assert.ok(sentinelDescriptor);
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

  const inventory = collectSemanticInventory([asElement(filledRepeat), asElement(emptyScalar)], adapter);
  assert.deepEqual(inventory.map(({ element }) => element), [filledRepeat, emptyScalar]);
  const repeatDescriptor = inventory.find(({ element }) => element === asElement(filledRepeat))?.descriptor;
  assert.ok(repeatDescriptor);
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
    const inventory = collectSemanticInventory([asElement(sentinel), asElement(empty)], adapter);
    assert.deepEqual(inventory.map(({ element }) => element), [sentinel, empty], state);
    const sentinelDescriptor = inventory.find(({ element }) => element === asElement(sentinel))?.descriptor;
    assert.ok(sentinelDescriptor, state);
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
  for (const type of ["password", "hidden", "file", "submit", "button", "reset", "image"] as const) {
    const control = new FakeElement("input", document);
    control.type = type;
    control.setAttribute("aria-label", type === "password" ? "密码" : "附件");
    control.throwOnValueRead = true;
    assert.equal(describeSemanticField(asElement(control), adapter), null, type);
    assert.deepEqual(collectSemanticInventory([asElement(control)], adapter), [], type);
    assert.equal(control.valueReadCount, 0, type);
  }
  const undescribed = new FakeElement("input", document);
  assert.equal(describeSemanticField(asElement(undescribed), adapter), null);
  assert.deepEqual(collectSemanticInventory([asElement(undescribed)], adapter), []);
});

test("semantic inventory reads zero input, textarea, select, or contenteditable values", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const input = new FakeElement("input", document);
  input.setAttribute("aria-label", "姓名");
  input.throwOnValueRead = true;
  const inheritedEditable = new FakeElement("div", document);
  inheritedEditable.isContentEditable = true;
  inheritedEditable.textContent = "不得进入语义的继承编辑正文";
  inheritedEditable.innerText = "不得进入语义的继承编辑正文";
  inheritedEditable.throwOnTextContentRead = true;
  inheritedEditable.throwOnInnerTextRead = true;
  input.previousElementSibling = inheritedEditable;
  const textarea = new FakeElement("textarea", document);
  textarea.setAttribute("aria-label", "个人简介");
  textarea.throwOnValueRead = true;
  textarea.textContent = "不得进入语义的服务端 textarea 正文";
  textarea.innerText = "不得进入语义的服务端 textarea 正文";
  textarea.throwOnTextContentRead = true;
  textarea.throwOnInnerTextRead = true;
  const textareaWrappingLabel = new FakeElement("label", document);
  textareaWrappingLabel.textContent = "个人简介 不得进入语义的服务端 textarea 正文";
  textareaWrappingLabel.innerText = "个人简介 不得进入语义的服务端 textarea 正文";
  textareaWrappingLabel.throwOnTextContentRead = true;
  textareaWrappingLabel.throwOnInnerTextRead = true;
  textarea.proxy = textareaWrappingLabel;
  textarea.parentElement = textareaWrappingLabel;
  const nestedDynamicChoice = new FakeElement("div", document);
  nestedDynamicChoice.className = "ant-select";
  nestedDynamicChoice.textContent = "不得进入语义的动态选择正文";
  nestedDynamicChoice.innerText = "不得进入语义的动态选择正文";
  nestedDynamicChoice.throwOnTextContentRead = true;
  nestedDynamicChoice.throwOnInnerTextRead = true;
  nestedDynamicChoice.parentElement = textareaWrappingLabel;
  nestedDynamicChoice.childNodes = [new FakeTextNode("不得进入语义的动态选择正文")];
  textareaWrappingLabel.childNodes = [new FakeTextNode("个人简介"), textarea, nestedDynamicChoice];
  const select = new FakeElement("select", document);
  select.setAttribute("aria-label", "学历");
  select.throwOnValueRead = true;
  let selectedReadCount = 0;
  select.options = [{
    text: "本科",
    value: "bachelor",
    disabled: false,
    get selected(): boolean {
      selectedReadCount += 1;
      throw new Error("selected getter must not be read");
    },
  }];
  const wrappingLabel = new FakeElement("label", document);
  wrappingLabel.textContent = "个人简介 不得进入语义的用户正文";
  wrappingLabel.innerText = "个人简介 不得进入语义的用户正文";
  wrappingLabel.throwOnTextContentRead = true;
  wrappingLabel.throwOnInnerTextRead = true;
  const editable = new FakeElement("div", document);
  editable.isContentEditable = true;
  editable.setAttribute("aria-label", "个人简介");
  editable.textContent = "不得进入语义或哈希的用户正文";
  editable.innerText = "不得进入语义或哈希的用户正文";
  editable.throwOnTextContentRead = true;
  editable.throwOnInnerTextRead = true;
  editable.proxy = wrappingLabel;
  editable.parentElement = wrappingLabel;
  editable.childNodes = [new FakeTextNode("不得进入语义或哈希的用户正文")];
  wrappingLabel.childNodes = [new FakeTextNode("个人简介"), editable];

  const inventory = collectSemanticInventory(
    [input, textarea, select, editable].map(asElement),
    adapter,
  );
  assert.deepEqual(inventory.map(({ element }) => element), [input, textarea, select, editable]);
  assert.equal(input.valueReadCount, 0);
  assert.equal(inheritedEditable.textContentReadCount, 0);
  assert.equal(inheritedEditable.innerTextReadCount, 0);
  assert.equal(textarea.valueReadCount, 0);
  assert.equal(textarea.textContentReadCount, 0);
  assert.equal(textarea.innerTextReadCount, 0);
  assert.equal(select.valueReadCount, 0);
  assert.equal(selectedReadCount, 0);
  assert.equal(editable.textContentReadCount, 0);
  assert.equal(editable.innerTextReadCount, 0);
  assert.equal(wrappingLabel.textContentReadCount, 0);
  assert.equal(wrappingLabel.innerTextReadCount, 0);
  assert.equal(textareaWrappingLabel.textContentReadCount, 0);
  assert.equal(textareaWrappingLabel.innerTextReadCount, 0);
  assert.equal(nestedDynamicChoice.textContentReadCount, 0);
  assert.equal(nestedDynamicChoice.innerTextReadCount, 0);
  assert.equal(JSON.stringify(inventory.map(({ descriptor }) => descriptor)).includes("不得进入语义"), false);

  const repeatRoot = new FakeElement("div", document);
  repeatRoot.childControls = [textarea, editable];
  repeatGroupStructureSignature(
    asElement(repeatRoot),
    "project",
    1,
    adapter,
    new WeakMap<Element, string>(),
    () => "node-1",
  );
  assert.equal(editable.textContentReadCount, 0);
  assert.equal(editable.innerTextReadCount, 0);
  assert.equal(wrappingLabel.textContentReadCount, 0);
  assert.equal(wrappingLabel.innerTextReadCount, 0);
  assert.equal(textareaWrappingLabel.textContentReadCount, 0);
  assert.equal(textareaWrappingLabel.innerTextReadCount, 0);
  assert.equal(textarea.textContentReadCount, 0);
  assert.equal(textarea.innerTextReadCount, 0);
  assert.equal(nestedDynamicChoice.textContentReadCount, 0);
  assert.equal(nestedDynamicChoice.innerTextReadCount, 0);

  // Beisen-style two-column rows put a static label beside an input wrapper,
  // not on the input or its immediate sibling. It remains value-blind.
  const beisenDocument = new FakeDocument("https://we.zyt.com/form?jobAdId=example");
  const beisenAdapter = getSiteAdapter(beisenDocument.location.href);
  for (const [caption, expectedKey] of [["姓名", "fullName"], ["手机号码", "phone"], ["邮箱", "email"]] as const) {
    const row = new FakeElement("div", beisenDocument);
    const label = new FakeElement("span", beisenDocument);
    label.innerText = caption;
    const inputWrapper = new FakeElement("div", beisenDocument);
    inputWrapper.previousElementSibling = label;
    inputWrapper.parentElement = row;
    const field = new FakeElement("input", beisenDocument);
    field.parentElement = inputWrapper;
    field.throwOnValueRead = true;
    const descriptor = describeSemanticField(asElement(field), beisenAdapter);
    assert.equal(descriptor?.label, caption);
    assert.equal(descriptor?.labelSource, "nearby");
    assert.equal(descriptor && semanticProfileKey(descriptor), expectedKey);
    assert.equal(field.valueReadCount, 0);
  }
  // A selected-value label inside a dropdown must not outrank the actual field title.
  const field = new FakeElement("input", beisenDocument);
  const item = new FakeElement("div", beisenDocument);
  const title = new FakeElement("div", beisenDocument); title.innerText = "性别";
  item.querySelector = () => title;
  field.closest = (selector) => selector === ".ud-formily-item,.mtd-form-item-body" ? item : null;
  field.throwOnValueRead = true;
  assert.equal(describeSemanticField(asElement(field), getSiteAdapter("https://zhaopin.meituan.com/"))?.label, "性别");
  assert.equal(field.valueReadCount, 0);
});

test("ignored OTP text controls are rejected before any value or text read", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const otp = new FakeElement("input", document);
  otp.setAttribute("aria-label", "短信验证码");
  otp.ignoredByAdapter = true;
  otp.throwOnValueRead = true;
  otp.throwOnTextContentRead = true;
  otp.throwOnInnerTextRead = true;

  assert.deepEqual(collectSemanticInventory([asElement(otp)], adapter), []);
  assert.equal(otp.valueReadCount, 0);
  assert.equal(otp.textContentReadCount, 0);
  assert.equal(otp.innerTextReadCount, 0);
});

test("required read-only sentinels block fills without becoming manual-count items", () => {
  const document = new FakeDocument("https://careers.example.test/apply");
  const candidates = [
    { identity: "required-sentinel", ownerDocument: asDocument(document), profileKey: "school" as const, repeated: false, actionable: false, required: true },
    { identity: "required-fill", ownerDocument: asDocument(document), profileKey: "school" as const, repeated: false, actionable: true, required: true },
  ];
  const resolution = resolveDuplicateSemanticCandidates(candidates);
  assert.deepEqual([...resolution.blockedIds].sort(), ["required-fill", "required-sentinel"]);
  assert.deepEqual([...resolution.reportIds], ["required-fill"]);
  assert.equal(candidates.filter((candidate) => candidate.required && resolution.reportIds.has(candidate.identity)).length, 1);
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

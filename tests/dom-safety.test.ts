import assert from "node:assert/strict";
import test from "node:test";

import {
  collectCandidates,
  collectScanDocuments,
  describeField,
  fillTarget,
  isEligible,
  resolveRepeatGroupIdentity,
} from "../src/dom-safety.ts";
import { matchDescriptor } from "../src/field-matcher.ts";
import { getSiteAdapter } from "../src/site-adapters.ts";
import { EMPTY_PROFILE, type ProfileData } from "../src/types.ts";

class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;

  constructor(type: string, options?: { bubbles?: boolean }) {
    this.type = type;
    this.bubbles = Boolean(options?.bubbles);
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
  display = "block";
  visibility = "visible";
  width = 180;
  height = 36;
  previousElementSibling: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  proxy: FakeElement | null = null;
  private currentValue = "";

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get value(): string {
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
    return null;
  }

  matches(): boolean {
    return false;
  }

  querySelector(): FakeElement | null {
    return null;
  }

  querySelectorAll(): FakeElement[] {
    return [];
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
    label: "Application form",
    reason: "cross_origin_iframe",
    required: false,
  }]);
  assert.equal(frame.contentDocumentReads, 1);
});

test("a hidden file input without a visible proxy is ignored, while a visible proxy stays manual", () => {
  const document = new FakeDocument("https://app.mokahr.com/apply");
  const adapter = getSiteAdapter(document.location.href);
  const hiddenFile = new FakeElement("input", document);
  hiddenFile.type = "file";
  hiddenFile.width = 0;
  hiddenFile.height = 0;
  hiddenFile.setAttribute("required", "");
  hiddenFile.setAttribute("aria-label", "上传简历");
  assert.equal(isEligible(asElement(hiddenFile), adapter), false);

  const visibleUploadButton = new FakeElement("label", document);
  hiddenFile.proxy = visibleUploadButton;
  assert.equal(isEligible(asElement(hiddenFile), adapter), true);
  const decision = matchDescriptor(describeField(asElement(hiddenFile), adapter), EMPTY_PROFILE);
  assert.deepEqual(decision, {
    action: "manual",
    profileKey: null,
    confidence: 1,
    reason: "attachment_user_required",
    value: null,
  });
});

test("repeat bindings follow node identity and require rebind after row replacement or insertion", () => {
  const rowA = {} as Element;
  const rowB = {} as Element;
  const rows = [rowA, rowB];
  const groupIds = new WeakMap<Element, string>();
  const bindings = new Map<string, string>();
  let sequence = 0;
  const allocate = () => `repeat-group-${++sequence}`;

  const first = resolveRepeatGroupIdentity(rowA, groupIds, bindings, allocate);
  bindings.set(first.groupKey, "experience-entry-2");
  rows.reverse();
  const afterMove = resolveRepeatGroupIdentity(rowA, groupIds, bindings, allocate);
  assert.deepEqual(afterMove, { groupKey: first.groupKey, targetEntryId: "experience-entry-2" });

  const inserted = {} as Element;
  rows.unshift(inserted);
  assert.deepEqual(resolveRepeatGroupIdentity(inserted, groupIds, bindings, allocate), {
    groupKey: "repeat-group-2",
    targetEntryId: undefined,
  });

  const replacement = {} as Element;
  rows[rows.indexOf(rowA)] = replacement;
  assert.deepEqual(resolveRepeatGroupIdentity(replacement, groupIds, bindings, allocate), {
    groupKey: "repeat-group-3",
    targetEntryId: undefined,
  });
});

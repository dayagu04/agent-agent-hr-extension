import type { ProfileFieldKey } from "./types";

export interface SiteAdapter {
  id: string;
  name: string;
  hostPattern: RegExp;
  labelSelectors: string[];
  ignoredSelectors: string[];
  repeatedGroupSelectors: string[];
  dynamicChoiceSelectors: string[];
  confidenceBoost(label: string, key: ProfileFieldKey): number;
}

const GENERIC_ADAPTER: SiteAdapter = {
  id: "generic",
  name: "通用规则",
  hostPattern: /.*/,
  labelSelectors: ["label", "[class*='label' i]", "[class*='title' i]", "[class*='question' i]", "[data-label]", "[data-field-label]"],
  ignoredSelectors: ["[class*='captcha' i]", "[class*='verify' i]", "[class*='password' i]"],
  repeatedGroupSelectors: ["[data-gugu-repeat-kind]", "fieldset", "[data-index]", "[data-row-key]", "[class*='experience-item' i]", "[class*='education-item' i]", "[class*='project-item' i]"],
  dynamicChoiceSelectors: ["[role='combobox']", "[aria-haspopup='listbox']", "[class*='cascader' i]", "[class*='select' i]"],
  confidenceBoost: () => 0,
};

const MOKA_ADAPTER: SiteAdapter = {
  id: "moka",
  name: "Moka",
  hostPattern: /(^|\.)mokahr\.com$/i,
  labelSelectors: [".ant-form-item-label", ".moka-form-item-label", "[class*='form-item-label' i]", "[class*='field-label' i]", "label"],
  ignoredSelectors: ["[class*='captcha' i]", "[class*='verify' i]", "[class*='password' i]", "[class*='sms' i]"],
  repeatedGroupSelectors: ["[data-gugu-repeat-kind]", "[data-index]", "[data-row-key]", "[class*='experience-item' i]", "[class*='education-item' i]", "[class*='project-item' i]", ".ant-form-list-item", "fieldset"],
  dynamicChoiceSelectors: ["[role='combobox']", "[aria-haspopup='listbox']", ".ant-select", ".ant-cascader-picker", "[class*='moka-select' i]", "[class*='sd-Select-container-']"],
  confidenceBoost: () => 0,
};

const BEISEN_ADAPTER: SiteAdapter = {
  id: "beisen",
  name: "北森",
  hostPattern: /(^|\.)zhiye\.com$|^we\.zyt\.com$/i,
  labelSelectors: [".ant-form-item-label", "[class*='form-label' i]", "[class*='field-label' i]", "[class*='question' i]", "label"],
  ignoredSelectors: ["[class*='captcha' i]", "[class*='verify' i]", "[class*='password' i]", "[class*='sms' i]"],
  repeatedGroupSelectors: ["[data-gugu-repeat-kind]", "[data-index]", "[data-row-key]", "[class*='experience-item' i]", "[class*='education-item' i]", "[class*='project-item' i]", ".ant-form-list-item", "fieldset"],
  dynamicChoiceSelectors: ["[role='combobox']", "[aria-haspopup='listbox']", ".ant-select", ".ant-cascader-picker", "[class*='select-control' i]"],
  confidenceBoost: () => 0,
};

const BYTEDANCE_ADAPTER: SiteAdapter = {
  id: "bytedance",
  name: "字节跳动招聘",
  hostPattern: /(^|\.)(jobs\.bytedance\.com|joinbytedance\.com)$/i,
  labelSelectors: [".ud-formily-item-label", ".semi-form-field-label", ".semi-form-field-label-text", "[class*='formLabel' i]", "[class*='question' i]", "label"],
  ignoredSelectors: ["[class*='captcha' i]", "[class*='verify' i]", "[class*='code' i]"],
  repeatedGroupSelectors: ["[data-gugu-repeat-kind]", "[data-index]", "[data-row-key]", "[class*='experience-item' i]", "[class*='education-item' i]", "[class*='project-item' i]", ".semi-form-list-item", "[class*='apply-form-array-card-content']", "fieldset"],
  dynamicChoiceSelectors: ["[role='combobox']", "[aria-haspopup='listbox']", ".semi-select", ".semi-cascader", ".ud__select"],
  confidenceBoost: (label, key) => key === "fullName" && /姓名|name/i.test(label) ? 0.06 : 0,
};

const TENCENT_ADAPTER: SiteAdapter = {
  id: "tencent",
  name: "腾讯招聘",
  hostPattern: /(^|\.)(join\.qq\.com|campus\.tencent\.com|careers\.tencent\.com)$/i,
  labelSelectors: [".form-item-label", ".form-label", "[class*='question' i]", "[class*='label' i]", "label"],
  ignoredSelectors: ["[class*='captcha' i]", "[class*='verify' i]"],
  repeatedGroupSelectors: GENERIC_ADAPTER.repeatedGroupSelectors,
  dynamicChoiceSelectors: GENERIC_ADAPTER.dynamicChoiceSelectors,
  confidenceBoost: (label, key) => key === "phone" && /手机|电话|mobile|phone/i.test(label) ? 0.05 : 0,
};

const ALIBABA_ADAPTER: SiteAdapter = {
  id: "alibaba",
  name: "阿里巴巴招聘",
  hostPattern: /(^|\.)((talent|campus)\.alibaba\.com)$/i,
  labelSelectors: [".form-item-label", ".next-form-item-label", "[class*='field-label' i]", "[class*='label' i]", "label"],
  ignoredSelectors: ["[class*='captcha' i]", "[class*='verify' i]", "[class*='sms' i]"],
  repeatedGroupSelectors: GENERIC_ADAPTER.repeatedGroupSelectors,
  dynamicChoiceSelectors: GENERIC_ADAPTER.dynamicChoiceSelectors,
  confidenceBoost: (label, key) => key === "email" && /邮箱|e-?mail/i.test(label) ? 0.05 : 0,
};

const SITE_ADAPTERS = [MOKA_ADAPTER, BEISEN_ADAPTER, BYTEDANCE_ADAPTER, TENCENT_ADAPTER, ALIBABA_ADAPTER, GENERIC_ADAPTER];

export function getSiteAdapter(url = window.location.href): SiteAdapter {
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { return GENERIC_ADAPTER; }
  return SITE_ADAPTERS.find((adapter) => adapter.hostPattern.test(hostname)) ?? GENERIC_ADAPTER;
}

function containsElement(container: HTMLElement, descendant: HTMLElement): boolean {
  if (container === descendant) return true;
  if (typeof container.contains === "function") return container.contains(descendant);
  let current = descendant.parentElement;
  while (current) {
    if (current === container) return true;
    current = current.parentElement;
  }
  return false;
}

const VALUE_BEARING_SELECTORS = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='combobox']",
  "[role='textbox']",
];

/**
 * Reads label text without ever reading the text/value subtree of a form
 * control. For an ordinary static label we retain native `innerText`; when a
 * label/container wraps any control, only standalone text nodes outside those
 * control subtrees are traversed.
 */
export function staticLabelTextOutsideControls(
  candidate: HTMLElement,
  field?: HTMLElement,
  extraControlSelectors: string[] = [],
): string {
  if (candidate === field) return "";
  const controlSelector = [...VALUE_BEARING_SELECTORS, ...extraControlSelectors].filter(Boolean).join(",");
  let candidateIsControl = candidate.isContentEditable;
  try { candidateIsControl ||= candidate.matches(controlSelector); } catch { candidateIsControl = true; }
  if (candidateIsControl) return "";
  const wrapsField = Boolean(field && containsElement(candidate, field));
  let containsControl = wrapsField;
  try { containsControl ||= Boolean(candidate.querySelector(controlSelector)); } catch { containsControl = true; }
  if (!containsControl) return candidate.innerText || candidate.textContent || "";

  const fragments: string[] = [];
  const visit = (node: Node) => {
    const childNodes = (node as Node & { childNodes?: NodeListOf<ChildNode> }).childNodes;
    if (!childNodes) return;
    for (const child of Array.from(childNodes)) {
      if (child.nodeType === 3) {
        fragments.push(child.textContent ?? "");
        continue;
      }
      if (child.nodeType !== 1) continue;
      const childElement = child as HTMLElement;
      if (childElement === field) continue;
      let isControl = childElement.isContentEditable;
      try { isControl ||= childElement.matches(controlSelector); } catch { isControl = true; }
      if (!isControl) visit(childElement);
    }
  };
  visit(candidate);
  return fragments.join(" ");
}

export function adapterLabelCandidates(element: HTMLElement, adapter: SiteAdapter): string[] {
  const labels: string[] = [];
  for (const selector of adapter.labelSelectors) {
    const closest = element.closest<HTMLElement>(selector);
    if (closest && closest !== element) labels.push(staticLabelTextOutsideControls(closest, element, adapter.dynamicChoiceSelectors));
    const parent = element.closest<HTMLElement>(".ud-formily-item, [class*='form-item' i], [class*='field' i], [class*='question' i], [data-field]");
    const child = parent?.querySelector<HTMLElement>(selector);
    if (child && child !== element) labels.push(staticLabelTextOutsideControls(child, element, adapter.dynamicChoiceSelectors));
  }
  return labels;
}

export function isIgnoredByAdapter(element: HTMLElement, adapter: SiteAdapter): boolean {
  return adapter.ignoredSelectors.some((selector) => Boolean(element.closest(selector)));
}


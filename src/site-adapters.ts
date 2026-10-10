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
  dynamicChoiceSelectors: ["[role='combobox']", "[aria-haspopup='listbox']", ".ant-select", ".ant-cascader-picker", "[class*='moka-select' i]"],
  confidenceBoost: () => 0,
};

const BEISEN_ADAPTER: SiteAdapter = {
  id: "beisen",
  name: "北森",
  hostPattern: /(^|\.)zhiye\.com$/i,
  labelSelectors: [".ant-form-item-label", "[class*='form-label' i]", "[class*='field-label' i]", "[class*='question' i]", "label"],
  ignoredSelectors: ["[class*='captcha' i]", "[class*='verify' i]", "[class*='password' i]", "[class*='sms' i]"],
  repeatedGroupSelectors: ["[data-gugu-repeat-kind]", "[data-index]", "[data-row-key]", "[class*='experience-item' i]", "[class*='education-item' i]", "[class*='project-item' i]", ".ant-form-list-item", "fieldset"],
  dynamicChoiceSelectors: ["[role='combobox']", "[aria-haspopup='listbox']", ".ant-select", ".ant-cascader-picker", "[class*='select-control' i]"],
  confidenceBoost: () => 0,
};

const BYTEDANCE_ADAPTER: SiteAdapter = {
  id: "bytedance",
  name: "字节跳动招聘",
  hostPattern: /(^|\.)jobs\.bytedance\.com$/i,
  labelSelectors: [".semi-form-field-label", ".semi-form-field-label-text", "[class*='formLabel' i]", "[class*='question' i]", "label"],
  ignoredSelectors: ["[class*='captcha' i]", "[class*='verify' i]", "[class*='code' i]"],
  repeatedGroupSelectors: ["[data-gugu-repeat-kind]", "[data-index]", "[data-row-key]", "[class*='experience-item' i]", "[class*='education-item' i]", "[class*='project-item' i]", ".semi-form-list-item", "fieldset"],
  dynamicChoiceSelectors: ["[role='combobox']", "[aria-haspopup='listbox']", ".semi-select", ".semi-cascader"],
  confidenceBoost: (label, key) => key === "fullName" && /姓名|name/i.test(label) ? 0.06 : 0,
};

const TENCENT_ADAPTER: SiteAdapter = {
  id: "tencent",
  name: "腾讯招聘",
  hostPattern: /(^|\.)(join\.qq\.com|campus\.tencent\.com)$/i,
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

export function adapterLabelCandidates(element: HTMLElement, adapter: SiteAdapter): string[] {
  const labels: string[] = [];
  for (const selector of adapter.labelSelectors) {
    const closest = element.closest<HTMLElement>(selector);
    if (closest && closest !== element) labels.push(closest.innerText || closest.textContent || "");
    const parent = element.closest<HTMLElement>("[class*='form-item' i], [class*='field' i], [class*='question' i], [data-field]");
    const child = parent?.querySelector<HTMLElement>(selector);
    if (child && child !== element) labels.push(child.innerText || child.textContent || "");
  }
  return labels;
}

export function isIgnoredByAdapter(element: HTMLElement, adapter: SiteAdapter): boolean {
  return adapter.ignoredSelectors.some((selector) => Boolean(element.closest(selector)));
}


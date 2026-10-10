import panelCss from "./content.css?inline";
import { matchDescriptor, type FieldControl, type FieldDescriptor } from "./field-matcher";
import { adapterLabelCandidates, getSiteAdapter, isIgnoredByAdapter, type SiteAdapter } from "./site-adapters";
import type { FieldMatch, ProfileData, ProfileFieldKey, StoredState } from "./types";

declare global {
  interface Window { __guguApplicationAssistantInstalled?: boolean; }
}

type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;
type FillTarget = FillableElement | HTMLInputElement[];

interface ElementSnapshot {
  element: FillableElement;
  value: string;
  checked?: boolean;
}

interface ManualField {
  label: string;
  reason: string;
}

const FIELD_LABELS: Record<ProfileFieldKey, string> = {
  fullName: "姓名", preferredName: "常用称呼", phone: "手机号", email: "邮箱", gender: "性别",
  birthDate: "出生日期", location: "现居城市", address: "详细地址", preferredLocation: "期望城市", website: "个人网站",
  github: "GitHub", school: "学校", major: "专业", degree: "学历", gpa: "GPA",
  educationStart: "入学时间", educationEnd: "毕业时间", summary: "个人简介", skills: "技能",
  experience: "实习 / 工作经历", projects: "项目经历", awards: "获奖经历",
};

let nextElementId = 0;

if (!window.__guguApplicationAssistantInstalled) {
  window.__guguApplicationAssistantInstalled = true;
  installAssistant();
}

function installAssistant() {
  const host = document.createElement("div");
  host.id = "gugu-application-assistant-host";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = panelCss;
  const root = document.createElement("div");
  root.className = "gugu-root";
  root.innerHTML = `
    <button class="gugu-bubble gugu-hidden" title="打开谷谷网申助手">谷</button>
    <aside class="gugu-panel gugu-hidden" aria-label="谷谷网申助手">
      <header class="gugu-header">
        <div class="gugu-brand"><span class="gugu-logo">谷</span><span class="gugu-title"><strong>谷谷网申助手</strong><small>先预览，再填写</small></span></div>
        <button class="gugu-icon-button" data-action="close" aria-label="关闭">×</button>
      </header>
      <section class="gugu-summary"><div class="gugu-progress"><strong data-role="count">正在识别…</strong><span class="gugu-tier" data-role="tier">一档 · 本地填写</span></div><p>只处理空白且可见的字段，不会点击“提交”或同意协议。</p></section>
      <div class="gugu-list" data-role="list"></div>
      <footer class="gugu-footer"><p class="gugu-notice" data-role="notice"></p><div class="gugu-actions"><button class="gugu-button gugu-secondary" data-action="rescan">重新识别</button><button class="gugu-button gugu-secondary gugu-hidden" data-action="undo">撤销本轮</button><button class="gugu-button gugu-primary" data-action="fill">填写已选字段</button></div></footer>
    </aside>`;
  shadow.append(style, root);
  document.documentElement.append(host);

  const panel = root.querySelector<HTMLElement>(".gugu-panel")!;
  const bubble = root.querySelector<HTMLButtonElement>(".gugu-bubble")!;
  const list = root.querySelector<HTMLElement>("[data-role=list]")!;
  const count = root.querySelector<HTMLElement>("[data-role=count]")!;
  const tier = root.querySelector<HTMLElement>("[data-role=tier]")!;
  const notice = root.querySelector<HTMLElement>("[data-role=notice]")!;
  const fillButton = root.querySelector<HTMLButtonElement>("[data-action=fill]")!;
  const undoButton = root.querySelector<HTMLButtonElement>("[data-action=undo]")!;
  const elements = new Map<string, FillTarget>();
  const descriptors = new Map<string, FieldDescriptor>();
  const elementIds = new WeakMap<FillableElement, string>();
  const adapter = getSiteAdapter();
  let state: StoredState | null = null;
  let matches: FieldMatch[] = [];
  let manualRequired: ManualField[] = [];
  let savedMappings: Record<string, ProfileFieldKey> = {};
  let selectedIds = new Set<string>();
  let hasRenderedOnce = false;
  let lastFill: ElementSnapshot[] = [];
  let panelOpen = false;
  let refreshTimer: number | undefined;

  function showNotice(message: string, error = false) {
    notice.textContent = message;
    notice.classList.toggle("error", error);
  }

  function escapeHtml(value: string) {
    return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
  }

  function render() {
    count.textContent = `可填写 ${matches.length} 个 · 必填需人工 ${manualRequired.length} 个 · ${adapter.name}`;
    tier.textContent = state?.ai.enabled ? "二档 · AI 可选" : "一档 · 本地填写";
    fillButton.disabled = matches.length === 0;
    undoButton.classList.toggle("gugu-hidden", lastFill.length === 0);
    const manualSummary = manualRequired.length
      ? `<div class="gugu-manual"><strong>以下可见必填项不会自动填写</strong>${manualRequired.map((item) => `<p>${escapeHtml(item.label || "未命名字段")} · ${escapeHtml(manualReason(item.reason))}</p>`).join("")}</div>`
      : "";
    if (!matches.length) {
      list.innerHTML = `<p class="gugu-empty">暂未找到能够可靠匹配的空白字段。可滚动页面让动态表单加载后，再重新识别。</p>${manualSummary}`;
      return;
    }
    list.innerHTML = matches.map((match) => {
      const canPolish = state?.ai.enabled && ["summary", "experience", "projects"].includes(match.key) && match.value.length >= 12;
      const displayValue = match.suggestedValue ?? match.value;
      const suggestion = match.suggestedValue
        ? `<small class="gugu-original">原文：${escapeHtml(match.value)}</small><textarea class="gugu-suggestion" data-action="edit-suggestion" aria-label="编辑 AI 建议">${escapeHtml(displayValue)}</textarea>${(match.factWarnings ?? []).map((warning) => `<small class="gugu-warning">⚠ ${escapeHtml(warning)}</small>`).join("")}`
        : `<span class="gugu-field-value" title="${escapeHtml(displayValue)}">${escapeHtml(displayValue) || "档案中暂无该字段"}</span>`;
      const checked = selectedIds.has(match.id);
      return `<div class="gugu-row" data-id="${match.id}">
        <input class="gugu-check" type="checkbox" ${checked ? "checked" : ""} aria-label="填写${escapeHtml(match.label)}" />
        <span class="gugu-field"><span class="gugu-field-label" title="${escapeHtml(match.label)}">${escapeHtml(match.label)}</span><select class="gugu-key-select" data-action="map" aria-label="将${escapeHtml(match.label)}映射为">${fieldOptions(match.key)}</select>${suggestion}</span>
        <span class="gugu-confidence ${match.confidence < 0.78 ? "medium" : ""}">${Math.round(match.confidence * 100)}%</span>
        ${canPolish ? `<button class="gugu-ai" data-action="polish" type="button">AI 润色此项</button>` : ""}
      </div>`;
    }).join("") + manualSummary;
  }

  async function refresh() {
    showNotice("");
    const response = await chrome.runtime.sendMessage({ type: "GET_ASSISTANT_STATE" }) as { ok: boolean; state?: StoredState; error?: string };
    if (!response.ok || !response.state) throw new Error(response.error || "无法读取个人档案");
    state = response.state;
    savedMappings = await loadSiteMappings();
    const scan = scanPage(state.profile, elements, descriptors, adapter, elementIds, savedMappings);
    matches = scan.matches;
    manualRequired = scan.manualRequired;
    selectedIds = new Set(matches.filter((match) => hasRenderedOnce ? selectedIds.has(match.id) : match.confidence >= 0.78).map((match) => match.id));
    hasRenderedOnce = true;
    render();
  }

  async function open() {
    panelOpen = true;
    panel.classList.remove("gugu-hidden");
    bubble.classList.add("gugu-hidden");
    try { await refresh(); } catch (error) { showNotice(error instanceof Error ? error.message : "识别失败", true); }
  }

  function close() {
    panelOpen = false;
    panel.classList.add("gugu-hidden");
    bubble.classList.remove("gugu-hidden");
  }

  root.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    const action = button?.dataset.action;
    if (button === bubble) return open();
    if (action === "close") return close();
    if (action === "rescan") {
      try { await refresh(); } catch (error) { showNotice(error instanceof Error ? error.message : "识别失败", true); }
      return;
    }
    if (action === "undo") {
      let restored = 0;
      for (const snapshot of lastFill) {
        if (restoreElement(snapshot)) restored += 1;
      }
      lastFill = [];
      render();
      showNotice(`已撤销 ${restored} 项填写。`);
      return;
    }
    if (action === "fill") {
      let filled = 0;
      const snapshots: ElementSnapshot[] = [];
      for (const row of list.querySelectorAll<HTMLElement>(".gugu-row")) {
        if (!row.querySelector<HTMLInputElement>(".gugu-check")?.checked) continue;
        const match = matches.find((item) => item.id === row.dataset.id);
        const target = match ? elements.get(match.id) : undefined;
        if (match && target) {
          const before = snapshotTarget(target);
          const fillValue = match.suggestedValue ?? match.resolvedValue;
          if (fillTarget(target, fillValue)) {
            snapshots.push(...before);
            filled += 1;
          }
        }
      }
      lastFill = snapshots;
      render();
      showNotice(`已填写 ${filled} 项。请逐项检查，确认无误后由你手动提交。`);
      return;
    }
    if (action === "polish" && button) {
      const row = button.closest<HTMLElement>(".gugu-row")!;
      const match = matches.find((item) => item.id === row.dataset.id);
      if (!match) return;
      button.disabled = true;
      button.textContent = "正在润色…";
      const response = await chrome.runtime.sendMessage({
        type: "POLISH_TEXT",
        request: { sourceText: match.value, question: match.label, companyContext: `${document.title} (${location.hostname})` },
      }) as { ok: boolean; text?: string; error?: string };
      if (response.ok && response.text) {
        match.suggestedValue = response.text;
        match.factWarnings = findFactWarnings(match.value, response.text);
        render();
        showNotice(match.factWarnings.length ? "AI 建议包含原文没有的数字或日期，请核实后再填写。" : "AI 建议已生成但尚未写入页面，请先检查内容，再点击填写。 ", Boolean(match.factWarnings.length));
      } else {
        button.disabled = false;
        button.textContent = "AI 润色此项";
        showNotice(response.error || "AI 润色失败", true);
      }
    }
  });

  root.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    const row = input.closest<HTMLElement>(".gugu-row");
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;
    const match = matches.find((item) => item.id === id);
    if (input instanceof HTMLSelectElement && input.dataset.action === "map" && match && state) {
      const key = input.value as ProfileFieldKey;
      const descriptor = descriptors.get(id);
      if (!descriptor) return;
      const decision = matchDescriptor(descriptor, state.profile, key);
      if (decision.action !== "fill" || !decision.profileKey || decision.value === null) {
        showNotice("该字段与所选档案项的控件或选项不兼容，已保持人工处理。", true);
        return;
      }
      match.key = decision.profileKey;
      match.value = state.profile[decision.profileKey];
      match.resolvedValue = decision.value;
      match.confidence = decision.confidence;
      savedMappings[descriptorMappingKey(descriptor)] = key;
      void saveSiteMapping(savedMappings);
      render();
      showNotice(match.value ? "已记住该站点的字段映射。" : "该字段在档案中暂无内容，请先补充个人档案。", !match.value);
      return;
    }
    if (input instanceof HTMLTextAreaElement && input.dataset.action === "edit-suggestion" && match) {
      match.suggestedValue = input.value;
      match.factWarnings = findFactWarnings(match.value, input.value);
      return;
    }
    if (!(input instanceof HTMLInputElement) || !input.classList.contains("gugu-check")) return;
    if (input.checked) selectedIds.add(id);
    else selectedIds.delete(id);
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { type?: string }).type === "OPEN_ASSISTANT") void open();
  });

  const observer = new MutationObserver((records) => {
    if (!panelOpen || records.every((record) => isAssistantMutation(record, host))) return;
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      void refresh().then(() => showNotice("页面新增字段，已自动更新识别结果。"), (error) => showNotice(error instanceof Error ? error.message : "动态字段识别失败", true));
    }, 350);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function isAssistantMutation(record: MutationRecord, host: HTMLElement): boolean {
  if (record.target === host || host.contains(record.target)) return true;
  return Array.from(record.addedNodes).every((node) => node instanceof Node && (node === host || host.contains(node)));
}

function scanPage(
  profile: ProfileData,
  elements: Map<string, FillTarget>,
  descriptors: Map<string, FieldDescriptor>,
  adapter: SiteAdapter,
  elementIds: WeakMap<FillableElement, string>,
  mappings: Record<string, ProfileFieldKey>,
): { matches: FieldMatch[]; manualRequired: ManualField[] } {
  elements.clear();
  descriptors.clear();
  const candidates = Array.from(document.querySelectorAll<FillableElement>("input, textarea, select, [contenteditable=true]"));
  const matches: FieldMatch[] = [];
  const manualRequired: ManualField[] = [];
  const processedGroups = new Set<string>();

  const addMatch = (target: FillTarget, anchor: FillableElement, descriptor: FieldDescriptor) => {
    const label = descriptor.label ?? "";
    const explicitKey = mappings[descriptorMappingKey(descriptor)];
    const decision = matchDescriptor(descriptor, profile, explicitKey);
    if (decision.action !== "fill" || !decision.profileKey || decision.value === null) {
      if (descriptor.required && decision.action === "manual") {
        manualRequired.push({ label: label.slice(0, 100), reason: decision.reason });
      }
      return;
    }
    const id = elementIds.get(anchor) ?? `field-${nextElementId++}`;
    elementIds.set(anchor, id);
    elements.set(id, target);
    descriptors.set(id, descriptor);
    matches.push({
      id,
      label: label.slice(0, 100) || FIELD_LABELS[decision.profileKey],
      key: decision.profileKey,
      value: profile[decision.profileKey],
      resolvedValue: decision.value,
      confidence: decision.confidence,
      kind: elementKind(anchor),
    });
  };

  for (const element of candidates) {
    if (!isEligible(element) || isIgnoredByAdapter(element, adapter)) continue;
    if (element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type) && element.name) {
      const groupKey = `${element.type}:${element.name}`;
      if (processedGroups.has(groupKey)) continue;
      processedGroups.add(groupKey);
      const group = candidates.filter((candidate): candidate is HTMLInputElement => (
        candidate instanceof HTMLInputElement
        && candidate.type === element.type
        && candidate.name === element.name
        && isEligible(candidate)
        && !isIgnoredByAdapter(candidate, adapter)
      ));
      if (!group.length || group.some((candidate) => candidate.checked)) continue;
      const descriptor = describeField(group[0], adapter);
      descriptor.controlType = element.type as "radio" | "checkbox";
      descriptor.multiple = element.type === "checkbox";
      descriptor.options = group.map((candidate) => ({
        label: optionLabel(candidate),
        value: candidate.value,
        disabled: candidate.disabled,
      }));
      addMatch(group, group[0], descriptor);
      continue;
    }
    addMatch(element, element, describeField(element, adapter));
  }
  return { matches: deduplicate(matches), manualRequired };
}

function manualReason(reason: string): string {
  const messages: Record<string, string> = {
    unknown_semantics: "字段语义未知",
    low_confidence: "识别置信度不足",
    ambiguous_semantics: "多个字段语义冲突",
    missing_profile_value: "个人档案缺少对应值",
    unsupported_control: "控件类型暂不支持",
    choice_not_found: "没有精确匹配的选项",
    ambiguous_choice: "存在重复或歧义选项",
    partial_multi_choice: "多选项只能部分匹配",
    invalid_date: "日期格式无效",
  };
  return messages[reason] ?? "需要人工确认";
}

function isEligible(element: FillableElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (rect.width < 4 || rect.height < 4 || style.display === "none" || style.visibility === "hidden") return false;
  if (element instanceof HTMLInputElement) {
    if (["hidden", "password", "file", "submit", "button", "reset", "image"].includes(element.type)) return false;
    if (element.disabled || element.readOnly) return false;
    if (!["checkbox", "radio"].includes(element.type) && element.value.trim()) return false;
  } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    if (element.disabled || ("readOnly" in element && element.readOnly)) return false;
    if (element instanceof HTMLTextAreaElement && element.value.trim()) return false;
    if (element instanceof HTMLSelectElement && element.value && element.selectedIndex > 0) return false;
  } else if (element.textContent?.trim()) return false;
  return true;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").replace(/[*：:]+$/g, "").trim();
}

function describeField(element: FillableElement, adapter: SiteAdapter): FieldDescriptor {
  const parts = new Set<string>();
  if (element.id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`);
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
    autocomplete: element instanceof HTMLInputElement ? element.autocomplete : "",
    controlType: elementControl(element),
    required: element.hasAttribute("required") || element.getAttribute("aria-required") === "true",
    disabled: "disabled" in element && Boolean(element.disabled),
    readOnly: "readOnly" in element && Boolean(element.readOnly),
    hasValue: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? Boolean(element.value.trim())
      : element instanceof HTMLSelectElement
        ? Boolean(element.value && element.selectedIndex > 0)
        : Boolean(element.textContent?.trim()),
    multiple: element instanceof HTMLSelectElement && element.multiple,
    options: element instanceof HTMLSelectElement
      ? Array.from(element.options).map((option) => ({ label: cleanText(option.text), value: option.value, disabled: option.disabled }))
      : [],
  };
}

function optionLabel(element: HTMLInputElement): string {
  if (element.id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`);
    if (label) return cleanText(label.innerText || label.textContent);
  }
  const wrapping = element.closest("label");
  return cleanText(wrapping?.innerText || wrapping?.textContent || element.value);
}

function elementControl(element: FillableElement): FieldControl {
  if (element instanceof HTMLTextAreaElement) return "textarea";
  if (element instanceof HTMLSelectElement) return "select";
  if (element instanceof HTMLInputElement) {
    const supported = new Set<FieldControl>(["text", "email", "tel", "url", "date", "month", "number", "radio", "checkbox", "hidden"]);
    return supported.has(element.type as FieldControl) ? element.type as FieldControl : "text";
  }
  return element.isContentEditable ? "contenteditable" : "unknown";
}

const MAPPINGS_STORAGE_KEY = "guguSiteMappings";

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 180);
}

function descriptorMappingKey(descriptor: FieldDescriptor): string {
  // A label by itself is not stable enough: repeated education/work groups
  // often reuse labels such as "开始时间".  Bind a learned correction to the
  // control shape and its independent semantic evidence so it cannot leak to
  // another field on the same host merely because the visible text matches.
  return [
    descriptor.controlType,
    descriptor.multiple ? "multiple" : "single",
    descriptor.label,
    descriptor.ariaLabel,
    descriptor.placeholder,
    descriptor.name,
  ].map((part) => normalizeLabel(String(part ?? ""))).join("|").slice(0, 720);
}

async function loadSiteMappings(): Promise<Record<string, ProfileFieldKey>> {
  const stored = await chrome.storage.local.get(MAPPINGS_STORAGE_KEY);
  const allMappings = stored[MAPPINGS_STORAGE_KEY] as Record<string, Record<string, ProfileFieldKey>> | undefined;
  return { ...(allMappings?.[location.hostname] ?? {}) };
}

async function saveSiteMapping(mapping: Record<string, ProfileFieldKey>): Promise<void> {
  const stored = await chrome.storage.local.get(MAPPINGS_STORAGE_KEY);
  const allMappings = (stored[MAPPINGS_STORAGE_KEY] as Record<string, Record<string, ProfileFieldKey>> | undefined) ?? {};
  allMappings[location.hostname] = mapping;
  await chrome.storage.local.set({ [MAPPINGS_STORAGE_KEY]: allMappings });
}

function fieldOptions(selected: ProfileFieldKey): string {
  return (Object.keys(FIELD_LABELS) as ProfileFieldKey[]).map((key) => `<option value="${key}" ${key === selected ? "selected" : ""}>${FIELD_LABELS[key]}</option>`).join("");
}

function findFactWarnings(source: string, suggestion: string): string[] {
  const warnings: string[] = [];
  const sourceNumbers = new Set(source.match(/\b\d+(?:\.\d+)?%?\b/g) ?? []);
  const addedNumbers = (suggestion.match(/\b\d+(?:\.\d+)?%?\b/g) ?? []).filter((number) => !sourceNumbers.has(number));
  if (addedNumbers.length) warnings.push(`新增数字：${Array.from(new Set(addedNumbers)).join("、")}`);
  const sourceDates = new Set(source.match(/\b(?:19|20)\d{2}(?:[-/.年]\d{1,2})?(?:[-/.月]\d{1,2})?\b/g) ?? []);
  const addedDates = (suggestion.match(/\b(?:19|20)\d{2}(?:[-/.年]\d{1,2})?(?:[-/.月]\d{1,2})?\b/g) ?? []).filter((date) => !sourceDates.has(date));
  if (addedDates.length) warnings.push(`新增日期：${Array.from(new Set(addedDates)).join("、")}`);
  return warnings;
}

function deduplicate(matches: FieldMatch[]): FieldMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const identity = `${match.id}:${match.key}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function elementKind(element: FillableElement): FieldMatch["kind"] {
  if (element instanceof HTMLTextAreaElement) return "textarea";
  if (element instanceof HTMLSelectElement) return "select";
  if (element instanceof HTMLInputElement && element.type === "radio") return "radio";
  if (element instanceof HTMLInputElement && element.type === "checkbox") return "checkbox";
  if (element instanceof HTMLInputElement) return "input";
  return "contenteditable";
}

function snapshotTarget(target: FillTarget): ElementSnapshot[] {
  const items = Array.isArray(target) ? target : [target];
  return items.map((element) => ({
    element,
    value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? element.value
      : element.textContent ?? "",
    checked: element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type) ? element.checked : undefined,
  }));
}

function fillTarget(target: FillTarget, value: string | string[]): boolean {
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
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set?.call(input, checked);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }
    if (element instanceof HTMLSelectElement) {
      const requested = Array.isArray(value) ? value : [value];
      if (!requested.length || requested.some((item) => !Array.from(element.options).some((option) => !option.disabled && option.value === item))) return false;
      if (element.multiple) {
        for (const option of element.options) option.selected = requested.includes(option.value);
      } else {
        if (requested.length !== 1) return false;
        element.value = requested[0];
      }
    } else if (element instanceof HTMLInputElement) {
      if (Array.isArray(value)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(element, value);
    } else if (element instanceof HTMLTextAreaElement) {
      if (Array.isArray(value)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, value);
    } else {
      if (Array.isArray(value)) return false;
      element.textContent = value;
    }
    const eventValue = Array.isArray(value) ? value.join(",") : value;
    element.focus();
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: eventValue }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

function restoreElement(snapshot: ElementSnapshot): boolean {
  const { element, value, checked } = snapshot;
  if (element instanceof HTMLInputElement && checked !== undefined) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set?.call(element, checked);
  } else if (element instanceof HTMLSelectElement) element.value = value;
  else if (element instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  } else if (element instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
  } else element.textContent = value;
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

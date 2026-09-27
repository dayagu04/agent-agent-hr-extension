import panelCss from "./content.css?inline";
import { adapterLabelCandidates, getSiteAdapter, isIgnoredByAdapter, type SiteAdapter } from "./site-adapters";
import type { FieldMatch, ProfileData, ProfileFieldKey, StoredState } from "./types";

declare global {
  interface Window { __guguApplicationAssistantInstalled?: boolean; }
}

type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

const FIELD_LABELS: Record<ProfileFieldKey, string> = {
  fullName: "姓名", preferredName: "常用称呼", phone: "手机号", email: "邮箱", gender: "性别",
  birthDate: "出生日期", location: "现居地", preferredLocation: "期望城市", website: "个人网站",
  github: "GitHub", school: "学校", major: "专业", degree: "学历", gpa: "GPA",
  educationStart: "入学时间", educationEnd: "毕业时间", summary: "个人简介", skills: "技能",
  experience: "实习 / 工作经历", projects: "项目经历", awards: "获奖经历",
};

const RULES: Array<{ key: ProfileFieldKey; patterns: RegExp[] }> = [
  { key: "email", patterns: [/电子?邮[箱件]/i, /e-?mail/i, /mail address/i] },
  { key: "phone", patterns: [/手机(号码)?/i, /联系电话/i, /电话号码/i, /mobile/i, /phone/i, /tel(?:ephone)?/i] },
  { key: "preferredName", patterns: [/常用称呼/i, /昵称/i, /preferred name/i] },
  { key: "fullName", patterns: [/^姓名/i, /真实姓名/i, /中文名/i, /full name/i, /candidate name/i] },
  { key: "gender", patterns: [/^性别/i, /^gender/i, /^sex$/i] },
  { key: "birthDate", patterns: [/出生日期/i, /出生年月/i, /birthday/i, /date of birth/i] },
  { key: "preferredLocation", patterns: [/期望.*(?:城市|地点|工作地)/i, /意向.*(?:城市|地点)/i, /preferred location/i] },
  { key: "location", patterns: [/现居/i, /居住地/i, /所在城市/i, /current location/i, /address/i] },
  { key: "github", patterns: [/github/i, /代码仓库/i] },
  { key: "website", patterns: [/个人网站/i, /主页链接/i, /作品链接/i, /portfolio/i, /personal website/i, /homepage/i] },
  { key: "school", patterns: [/学校名称/i, /毕业院校/i, /^学校/i, /university/i, /college/i, /school/i] },
  { key: "major", patterns: [/所学专业/i, /^专业/i, /major/i, /field of study/i] },
  { key: "degree", patterns: [/最高学历/i, /^学历/i, /学位/i, /degree/i, /education level/i] },
  { key: "gpa", patterns: [/gpa/i, /绩点/i, /成绩排名/i] },
  { key: "educationStart", patterns: [/入学时间/i, /教育.*开始/i, /start.*(?:school|education)/i] },
  { key: "educationEnd", patterns: [/毕业时间/i, /预计毕业/i, /教育.*结束/i, /graduation/i] },
  { key: "projects", patterns: [/项目(?:经历|描述|介绍|经验)/i, /project experience/i, /projects?/i] },
  { key: "awards", patterns: [/获奖/i, /奖项/i, /荣誉/i, /awards?/i, /honors?/i] },
  { key: "experience", patterns: [/实习(?:经历|描述)/i, /工作(?:经历|描述)/i, /职责描述/i, /experience/i, /employment/i] },
  { key: "skills", patterns: [/专业技能/i, /^技能/i, /技术栈/i, /skills?/i] },
  { key: "summary", patterns: [/自我介绍/i, /个人优势/i, /自我评价/i, /个人总结/i, /补充说明/i, /summary/i, /about (?:you|yourself)/i, /why.*(?:join|apply)/i] },
];

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
  const elements = new Map<string, FillableElement>();
  const elementIds = new WeakMap<FillableElement, string>();
  const adapter = getSiteAdapter();
  let state: StoredState | null = null;
  let matches: FieldMatch[] = [];
  let savedMappings: Record<string, ProfileFieldKey> = {};
  let selectedIds = new Set<string>();
  let hasRenderedOnce = false;
  let lastFill: Array<{ element: FillableElement; value: string }> = [];
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
    count.textContent = `识别到 ${matches.length} 个字段 · ${adapter.name}`;
    tier.textContent = state?.ai.enabled ? "二档 · AI 可选" : "一档 · 本地填写";
    fillButton.disabled = matches.length === 0;
    undoButton.classList.toggle("gugu-hidden", lastFill.length === 0);
    if (!matches.length) {
      list.innerHTML = `<p class="gugu-empty">暂未找到能够可靠匹配的空白字段。可滚动页面让动态表单加载后，再重新识别。</p>`;
      return;
    }
    list.innerHTML = matches.map((match) => {
      const canPolish = state?.ai.enabled && ["summary", "experience", "projects"].includes(match.key) && match.value.length >= 12;
      const checked = selectedIds.has(match.id);
      return `<div class="gugu-row" data-id="${match.id}">
        <input class="gugu-check" type="checkbox" ${checked ? "checked" : ""} aria-label="填写${escapeHtml(match.label)}" />
        <span class="gugu-field"><span class="gugu-field-label" title="${escapeHtml(match.label)}">${escapeHtml(match.label)}</span><select class="gugu-key-select" data-action="map" aria-label="将${escapeHtml(match.label)}映射为">${fieldOptions(match.key)}</select><span class="gugu-field-value" title="${escapeHtml(match.value)}">${escapeHtml(match.value) || "档案中暂无该字段"}</span></span>
        <span class="gugu-confidence ${match.confidence < 0.78 ? "medium" : ""}">${Math.round(match.confidence * 100)}%</span>
        ${canPolish ? `<button class="gugu-ai" data-action="polish" type="button">AI 润色此项</button>` : ""}
      </div>`;
    }).join("");
  }

  async function refresh() {
    showNotice("");
    const response = await chrome.runtime.sendMessage({ type: "GET_ASSISTANT_STATE" }) as { ok: boolean; state?: StoredState; error?: string };
    if (!response.ok || !response.state) throw new Error(response.error || "无法读取个人档案");
    state = response.state;
    savedMappings = await loadSiteMappings();
    matches = scanPage(state.profile, elements, adapter, elementIds, savedMappings);
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
        if (restoreElement(snapshot.element, snapshot.value)) restored += 1;
      }
      lastFill = [];
      render();
      showNotice(`已撤销 ${restored} 项填写。`);
      return;
    }
    if (action === "fill") {
      let filled = 0;
      const snapshots: Array<{ element: FillableElement; value: string }> = [];
      for (const row of list.querySelectorAll<HTMLElement>(".gugu-row")) {
        if (!row.querySelector<HTMLInputElement>(".gugu-check")?.checked) continue;
        const match = matches.find((item) => item.id === row.dataset.id);
        const element = match ? elements.get(match.id) : undefined;
        if (match && element) {
          const originalValue = readElementValue(element);
          if (fillElement(element, match.value)) {
            snapshots.push({ element, value: originalValue });
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
        match.value = response.text;
        render();
        showNotice("AI 建议已生成但尚未写入页面，请先检查内容，再点击填写。 ");
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
      match.key = key;
      match.value = state.profile[key];
      match.confidence = 0.96;
      savedMappings[normalizeLabel(match.label)] = key;
      void saveSiteMapping(savedMappings);
      render();
      showNotice(match.value ? "已记住该站点的字段映射。" : "该字段在档案中暂无内容，请先补充个人档案。", !match.value);
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

function scanPage(profile: ProfileData, elements: Map<string, FillableElement>, adapter: SiteAdapter, elementIds: WeakMap<FillableElement, string>, mappings: Record<string, ProfileFieldKey>): FieldMatch[] {
  elements.clear();
  const candidates = Array.from(document.querySelectorAll<FillableElement>("input, textarea, select, [contenteditable=true]"));
  const matches: FieldMatch[] = [];
  for (const element of candidates) {
    if (!isEligible(element) || isIgnoredByAdapter(element, adapter)) continue;
    const label = describeElement(element, adapter);
    const match = matchField(label, element, profile, adapter, mappings);
    if (!match) continue;
    const id = elementIds.get(element) ?? `field-${nextElementId++}`;
    elementIds.set(element, id);
    elements.set(id, element);
    matches.push({ id, label: label.slice(0, 100) || FIELD_LABELS[match.key], key: match.key, value: match.value, confidence: match.confidence, kind: elementKind(element) });
  }
  return deduplicate(matches);
}

function isEligible(element: FillableElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (rect.width < 4 || rect.height < 4 || style.display === "none" || style.visibility === "hidden") return false;
  if (element instanceof HTMLInputElement) {
    if (["hidden", "password", "file", "checkbox", "radio", "submit", "button", "reset", "image"].includes(element.type)) return false;
    if (element.disabled || element.readOnly || element.value.trim()) return false;
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

function describeElement(element: FillableElement, adapter: SiteAdapter): string {
  const parts = new Set<string>();
  if (element.id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`);
    if (label) parts.add(cleanText(label.innerText));
  }
  const wrappingLabel = element.closest("label");
  if (wrappingLabel) parts.add(cleanText(wrappingLabel.textContent));
  for (const attribute of ["aria-label", "placeholder", "name", "id", "title", "data-placeholder"]) {
    parts.add(cleanText(element.getAttribute(attribute)));
  }
  const container = element.closest("[class*='form-item'], [class*='field'], [class*='question'], .ant-form-item, .el-form-item");
  if (container) {
    const explicit = container.querySelector<HTMLElement>("label, [class*='label'], [class*='title']");
    if (explicit && explicit !== element) parts.add(cleanText(explicit.innerText).slice(0, 120));
  }
  const previous = element.previousElementSibling as HTMLElement | null;
  if (previous) parts.add(cleanText(previous.innerText).slice(0, 100));
  for (const candidate of adapterLabelCandidates(element, adapter)) parts.add(cleanText(candidate).slice(0, 120));
  return Array.from(parts).filter(Boolean).join(" | ");
}

function matchField(label: string, element: FillableElement, profile: ProfileData, adapter: SiteAdapter, mappings: Record<string, ProfileFieldKey>): { key: ProfileFieldKey; value: string; confidence: number } | null {
  const lowered = label.toLowerCase();
  if (/(验证码|密码|确认密码|邀请码|搜索|captcha|verification code|password|search)/i.test(lowered)) return null;
  const mappedKey = mappings[normalizeLabel(label)];
  if (mappedKey && profile[mappedKey]) return { key: mappedKey, value: profile[mappedKey], confidence: 0.96 };
  if (element instanceof HTMLInputElement) {
    if (element.type === "email" && profile.email) return { key: "email", value: profile.email, confidence: 0.98 };
    if (element.type === "tel" && profile.phone) return { key: "phone", value: profile.phone, confidence: 0.98 };
    if (element.autocomplete === "name" && profile.fullName) return { key: "fullName", value: profile.fullName, confidence: 0.95 };
    if (element.autocomplete === "email" && profile.email) return { key: "email", value: profile.email, confidence: 0.95 };
    if (element.autocomplete === "tel" && profile.phone) return { key: "phone", value: profile.phone, confidence: 0.95 };
  }
  for (const rule of RULES) {
    const matchedPattern = rule.patterns.find((pattern) => pattern.test(label));
    if (!matchedPattern || !profile[rule.key]) continue;
    const exactish = label.length < 36 || matchedPattern.source.startsWith("^");
    const confidence = exactish ? 0.9 : 0.72;
    return { key: rule.key, value: profile[rule.key], confidence: Math.min(0.98, confidence + adapter.confidenceBoost(label, rule.key)) };
  }
  return null;
}

const MAPPINGS_STORAGE_KEY = "guguSiteMappings";

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 180);
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
  if (element instanceof HTMLInputElement) return "input";
  return "contenteditable";
}

function fillElement(element: FillableElement, value: string): boolean {
  try {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    if (element instanceof HTMLSelectElement) {
      const normalized = value.toLowerCase();
      const option = Array.from(element.options).find((item) => item.value.toLowerCase() === normalized || item.text.toLowerCase() === normalized)
        ?? Array.from(element.options).find((item) => item.text.toLowerCase().includes(normalized) || normalized.includes(item.text.toLowerCase()));
      if (!option) return false;
      element.value = option.value;
    } else if (element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(element, value);
    } else if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, value);
    } else {
      element.textContent = value;
    }
    element.focus();
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

function readElementValue(element: FillableElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
  return element.textContent ?? "";
}

function restoreElement(element: FillableElement, value: string): boolean {
  if (element instanceof HTMLSelectElement) element.value = value;
  else if (element instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  } else if (element instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
  } else element.textContent = value;
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

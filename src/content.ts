import panelCss from "./content.css?inline";
import {
  collectCandidates,
  collectSemanticInventory,
  collectScanDocuments,
  deduplicateManualFields,
  describeField,
  describeSemanticField,
  fillTarget,
  isEligible,
  isInputElement,
  isSelectElement,
  isTextareaElement,
  optionLabel,
  RepeatBindingStore,
  registerFrameLoadListeners,
  repeatedMatchIdentity,
  repeatGroupStructureSignature,
  resolveRepeatGroupIdentity,
  resolveDuplicateSemanticCandidates,
  restoreElement,
  scopeNamedChoiceGroup,
  snapshotTarget,
  validateCachedFillTarget,
  type ElementSnapshot,
  type FillableElement,
  type FillTarget,
  type ManualField,
  type RepeatGroupIdentity,
} from "./dom-safety";
import { isAiPolishAllowed, matchDescriptor, semanticProfileKey, type FieldDescriptor } from "./field-matcher";
import { inferStructuredEntryField, inferStructuredEntryKind, structuredEntryOptions, type StructuredEntryOption } from "./repeat-context.ts";
import { getSiteAdapter, isIgnoredByAdapter, staticLabelTextOutsideControls, type SiteAdapter } from "./site-adapters";
import type { FieldMatch, ProfileData, ProfileFieldKey, RepeatedFieldContext, StoredState, StructuredEntryKind } from "./types";

declare global {
  interface Window { __guguApplicationAssistantInstalled?: boolean; }
}

interface RepeatGroupPrompt {
  groupKey: string;
  groupLabel: string;
  kind: StructuredEntryKind;
  selectedEntryId?: string;
  options: StructuredEntryOption[];
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
  const repeatGroupIds = new WeakMap<Element, RepeatGroupIdentity>();
  const repeatStructureNodeIds = new WeakMap<Element, string>();
  const adapter = getSiteAdapter();
  let state: StoredState | null = null;
  let matches: FieldMatch[] = [];
  let manualRequired: ManualField[] = [];
  let manualAttention: ManualField[] = [];
  let repeatGroups: RepeatGroupPrompt[] = [];
  const repeatBindings = new RepeatBindingStore();
  let savedMappings: Record<string, ProfileFieldKey> = {};
  let selectedIds = new Set<string>();
  let hasRenderedOnce = false;
  let lastFill: ElementSnapshot[] = [];
  let panelOpen = false;
  let refreshTimer: number | undefined;
  let pageObservers: MutationObserver[] = [];
  let pageActivityCleanups: Array<() => void> = [];
  let assistantWriteInProgress = false;

  function showNotice(message: string, error = false) {
    notice.textContent = message;
    notice.classList.toggle("error", error);
  }

  function escapeHtml(value: string) {
    return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
  }

  function render() {
    count.textContent = `可填写 ${matches.length} 个 · 必填需人工 ${manualRequired.length} 个 · 其他需确认 ${manualAttention.length} 个 · ${adapter.name}`;
    tier.textContent = state?.ai.enabled ? "二档 · AI 可选" : "一档 · 本地填写";
    fillButton.disabled = matches.length === 0;
    undoButton.classList.toggle("gugu-hidden", lastFill.length === 0);
    const repeatSummary = repeatGroups.length
      ? `<div class="gugu-manual"><strong>重复经历必须先绑定档案记录</strong>${repeatGroups.map((group) => `<label>${escapeHtml(group.groupLabel)}<select data-action="bind-entry" data-group-key="${escapeHtml(group.groupKey)}" data-scan-epoch="${repeatBindings.epoch}"><option value="">请选择，不会默认使用第一条</option>${group.options.map((option) => `<option value="${escapeHtml(option.id)}" ${option.id === group.selectedEntryId ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></label>`).join("")}</div>`
      : "";
    const manualItems = [...manualRequired, ...manualAttention];
    const manualSummary = manualItems.length
      ? `<div class="gugu-manual"><strong>以下控件不会自动处理</strong>${manualItems.map((item) => `<p>${escapeHtml(item.label || "未命名字段")} · ${item.required ? "必填 · " : ""}${escapeHtml(manualReason(item.reason))}</p>`).join("")}</div>`
      : "";
    if (!matches.length) {
      list.innerHTML = `<p class="gugu-empty">暂未找到能够可靠匹配的空白字段。可滚动页面让动态表单加载后，再重新识别。</p>${repeatSummary}${manualSummary}`;
      return;
    }
    list.innerHTML = matches.map((match) => {
      const canPolish = state?.ai.enabled && match.aiPolishable && match.value.length >= 12;
      const displayValue = match.suggestedValue ?? match.value;
      const suggestion = match.suggestedValue
        ? `<small class="gugu-original">原文：${escapeHtml(match.value)}</small><textarea class="gugu-suggestion" data-action="edit-suggestion" aria-label="编辑 AI 建议">${escapeHtml(displayValue)}</textarea>${(match.factWarnings ?? []).map((warning) => `<small class="gugu-warning">⚠ ${escapeHtml(warning)}</small>`).join("")}`
        : `<span class="gugu-field-value" title="${escapeHtml(displayValue)}">${escapeHtml(displayValue) || "档案中暂无该字段"}</span>`;
      const checked = selectedIds.has(match.id);
      const mappingControl = match.mappingLocked
        ? `<span class="gugu-record-source">${escapeHtml(match.recordLabel ?? "已绑定结构化记录")}</span>`
        : `<select class="gugu-key-select" data-action="map" aria-label="将${escapeHtml(match.label)}映射为">${fieldOptions(match.key)}</select>`;
      return `<div class="gugu-row" data-id="${match.id}">
        <input class="gugu-check" type="checkbox" ${checked ? "checked" : ""} aria-label="填写${escapeHtml(match.label)}" />
        <span class="gugu-field"><span class="gugu-field-label" title="${escapeHtml(match.label)}">${escapeHtml(match.label)}</span>${mappingControl}${suggestion}</span>
        <span class="gugu-confidence ${match.confidence < 0.78 ? "medium" : ""}">${Math.round(match.confidence * 100)}%</span>
        ${canPolish ? `<button class="gugu-ai" data-action="polish" type="button">AI 润色此项</button>` : ""}
      </div>`;
    }).join("") + repeatSummary + manualSummary;
  }

  async function refresh() {
    showNotice("");
    const response = await chrome.runtime.sendMessage({ type: "GET_ASSISTANT_STATE" }) as { ok: boolean; state?: StoredState; error?: string };
    if (!response.ok || !response.state) throw new Error(response.error || "无法读取个人档案");
    state = response.state;
    savedMappings = await loadSiteMappings();
    const scan = scanPage(
      state.profile,
      elements,
      descriptors,
      adapter,
      elementIds,
      savedMappings,
      repeatBindings,
      repeatGroupIds,
      repeatStructureNodeIds,
    );
    matches = scan.matches;
    manualRequired = scan.manualRequired;
    manualAttention = scan.manualAttention;
    repeatGroups = scan.repeatGroups;
    observeDocuments(scan.documents, host, () => {
      invalidateRepeatSnapshot();
      if (!panelOpen) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refresh().then(() => showNotice("页面已变化；重复经历需重新绑定，识别结果已更新。"), (error) => showNotice(error instanceof Error ? error.message : "动态字段识别失败", true));
      }, 350);
    }, () => {
      if (assistantWriteInProgress) return;
      invalidateRepeatSnapshot();
      if (!panelOpen) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refresh().then(() => showNotice("页面字段发生输入或选择；重复经历需重新绑定。"), (error) => showNotice(error instanceof Error ? error.message : "动态字段识别失败", true));
      }, 150);
    }, () => {
      invalidateRepeatSnapshot();
      if (!panelOpen) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refresh().then(() => showNotice("iframe 已加载；重复经历需重新绑定，表单控件已重新检查。"), (error) => showNotice(error instanceof Error ? error.message : "iframe 识别失败", true));
      }, 100);
    });
    selectedIds = new Set(matches.filter((match) => hasRenderedOnce ? selectedIds.has(match.id) : match.confidence >= 0.78).map((match) => match.id));
    hasRenderedOnce = true;
    render();
  }

  async function open() {
    invalidateRepeatSnapshot();
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
      invalidateRepeatSnapshot();
      try { await refresh(); } catch (error) { showNotice(error instanceof Error ? error.message : "识别失败", true); }
      return;
    }
    if (action === "undo") {
      let restored = 0;
      assistantWriteInProgress = true;
      try {
        for (const snapshot of lastFill) {
          if (restoreElement(snapshot)) restored += 1;
        }
      } finally {
        assistantWriteInProgress = false;
      }
      lastFill = [];
      invalidateRepeatSnapshot();
      try { await refresh(); } catch (error) { showNotice(error instanceof Error ? error.message : "撤销后重新识别失败", true); return; }
      showNotice(`已撤销 ${restored} 项填写；重复经历需重新绑定。`);
      return;
    }
    if (action === "fill") {
      let filled = 0;
      let stale = 0;
      const snapshots: ElementSnapshot[] = [];
      const selectedMatchIds = Array.from(list.querySelectorAll<HTMLElement>(".gugu-row"))
        .filter((row) => row.querySelector<HTMLInputElement>(".gugu-check")?.checked)
        .map((row) => row.dataset.id)
        .filter((id): id is string => Boolean(id));
      assistantWriteInProgress = true;
      try {
        for (const id of selectedMatchIds) {
          const cachedMatch = matches.find((item) => item.id === id);
          const cachedTarget = elements.get(id);
          const cachedDescriptor = descriptors.get(id);
          if (!cachedMatch || !cachedTarget || !cachedDescriptor || !state) {
            stale += 1;
            continue;
          }

          const currentElements = new Map<string, FillTarget>();
          const currentDescriptors = new Map<string, FieldDescriptor>();
          const currentScan = scanPage(
            state.profile,
            currentElements,
            currentDescriptors,
            adapter,
            elementIds,
            savedMappings,
            repeatBindings,
            repeatGroupIds,
            repeatStructureNodeIds,
          );
          const currentMatch = currentScan.matches.find((item) => item.id === id);
          const currentTarget = currentElements.get(id);
          const currentDescriptor = currentDescriptors.get(id);
          if (!currentMatch || !currentTarget || !currentDescriptor) {
            stale += 1;
            continue;
          }
          const validation = validateCachedFillTarget(cachedTarget, currentTarget, cachedDescriptor, currentDescriptor, adapter);
          if (!validation.valid) {
            stale += 1;
            continue;
          }
          const before = snapshotTarget(currentTarget);
          const fillValue = cachedMatch.suggestedValue ?? currentMatch.resolvedValue;
          if (fillTarget(currentTarget, fillValue)) {
            snapshots.push(...before);
            filled += 1;
          }
        }
      } finally {
        assistantWriteInProgress = false;
      }
      lastFill = snapshots;
      invalidateRepeatSnapshot();
      try { await refresh(); } catch (error) { showNotice(error instanceof Error ? error.message : "填写后重新识别失败", true); return; }
      showNotice(`已填写 ${filled} 项${stale ? `，跳过 ${stale} 个扫描后已变化的过期项` : ""}。请逐项检查，确认无误后由你手动提交。`, stale > 0);
      return;
    }
    if (action === "polish" && button) {
      const row = button.closest<HTMLElement>(".gugu-row")!;
      const match = matches.find((item) => item.id === row.dataset.id);
      if (!match?.aiPolishable) {
        showNotice("事实字段不允许 AI 润色，请直接核对档案原值。", true);
        return;
      }
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
    if (input instanceof HTMLSelectElement && input.dataset.action === "bind-entry") {
      const groupKey = input.dataset.groupKey;
      if (!groupKey) return;
      if (Number(input.dataset.scanEpoch) !== repeatBindings.epoch) {
        input.value = "";
        void refresh().then(
          () => showNotice("页面在本次识别后已变化，请在刷新后的行上重新绑定。", true),
          (error) => showNotice(error instanceof Error ? error.message : "重新识别失败", true),
        );
        return;
      }
      for (const [id, descriptor] of descriptors) {
        if (descriptor.repeated?.groupKey === groupKey) selectedIds.delete(id);
      }
      const selectedEntryId = input.value;
      if (selectedEntryId) repeatBindings.set(groupKey, selectedEntryId);
      else repeatBindings.delete(groupKey);
      void refresh().then(
        () => {
          if (selectedEntryId && repeatBindings.get(groupKey) !== selectedEntryId) {
            showNotice("页面在绑定过程中发生变化，绑定未保留，请重新选择。", true);
            return;
          }
          showNotice(selectedEntryId ? "已绑定该页面行，仍需逐字段预览后填写。" : "已取消重复经历绑定。");
        },
        (error) => showNotice(error instanceof Error ? error.message : "绑定后重新识别失败", true),
      );
      return;
    }
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
      match.aiPolishable = isAiPolishAllowed(descriptor, key);
      match.suggestedValue = undefined;
      match.factWarnings = undefined;
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

  function invalidateRepeatSnapshot() {
    repeatBindings.invalidate();
    for (const [id, descriptor] of descriptors) {
      if (descriptor.repeated) selectedIds.delete(id);
    }
  }

  function observeDocuments(
    documents: Document[],
    assistantHost: HTMLElement,
    onMutation: () => void,
    onPageActivity: () => void,
    onFrameLoad: () => void,
  ) {
    for (const observer of pageObservers) observer.disconnect();
    for (const cleanup of pageActivityCleanups) cleanup();
    pageActivityCleanups = documents.flatMap((scanDocument) => {
      const listener = (event: Event) => {
        if (scanDocument === document && event.composedPath().includes(assistantHost)) return;
        onPageActivity();
      };
      scanDocument.addEventListener("input", listener, true);
      scanDocument.addEventListener("change", listener, true);
      return [
        () => scanDocument.removeEventListener("input", listener, true),
        () => scanDocument.removeEventListener("change", listener, true),
      ];
    }).concat(registerFrameLoadListeners(documents, onFrameLoad));
    pageObservers = documents.map((scanDocument) => {
      const observer = new MutationObserver((records) => {
        if (records.every((record) => scanDocument === document && isAssistantMutation(record, assistantHost))) return;
        onMutation();
      });
      observer.observe(scanDocument.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          "id", "name", "type", "form", "role", "aria-label", "aria-required", "aria-disabled", "aria-readonly", "placeholder",
          "disabled", "readonly", "required", "checked", "selected", "value", "class", "style",
          "data-field", "data-index", "data-row-key", "data-key", "data-section", "data-type", "data-gugu-repeat-kind",
        ],
      });
      return observer;
    });
  }
}

function isAssistantMutation(record: MutationRecord, host: HTMLElement): boolean {
  if (record.target === host || host.contains(record.target)) return true;
  const addedNodes = Array.from(record.addedNodes);
  return addedNodes.length > 0 && addedNodes.every((node) => node === host || host.contains(node));
}

function repeatSignal(element: Element, adapter: SiteAdapter): string {
  const values: string[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    values.push(
      current.tagName,
      current.id,
      current.className,
      current.getAttribute("data-section") ?? "",
      current.getAttribute("data-type") ?? "",
      current.getAttribute("aria-label") ?? "",
    );
    const heading = current.querySelector<HTMLElement>(":scope > legend, :scope > h2, :scope > h3, :scope > h4, :scope > [class*='section-title' i], :scope > [class*='group-title' i]");
    if (heading) values.push(cleanText(staticLabelTextOutsideControls(heading, undefined, adapter.dynamicChoiceSelectors)).slice(0, 100));
    const previous = current.previousElementSibling;
    if (previous?.matches("legend, h2, h3, h4, [class*='section-title' i], [class*='group-title' i]")) {
      values.push(cleanText(staticLabelTextOutsideControls(previous as HTMLElement, undefined, adapter.dynamicChoiceSelectors)).slice(0, 100));
    }
  }
  return values.filter(Boolean).join(" ");
}

function repeatedControlCount(element: Element): number {
  return element.querySelectorAll("input, textarea, select, [contenteditable=true], [role=combobox]").length;
}

function hasRepeatedSiblingShape(element: Element): boolean {
  const parent = element.parentElement;
  if (!parent) return false;
  const signature = `${element.tagName}:${element.className}`;
  return Array.from(parent.children).filter((sibling) => (
    `${sibling.tagName}:${sibling.className}` === signature && repeatedControlCount(sibling) >= 2
  )).length >= 2;
}

function findRepeatedRoot(element: FillableElement, adapter: SiteAdapter): { root: Element; kind: StructuredEntryKind } | null {
  const explicit = element.closest<HTMLElement>("[data-gugu-repeat-kind]");
  if (explicit) {
    const kind = inferStructuredEntryKind(explicit.dataset.guguRepeatKind ?? repeatSignal(explicit, adapter));
    if (kind) return { root: explicit, kind };
  }
  const selectors = adapter.repeatedGroupSelectors.join(",");
  let current: Element | null = element.parentElement;
  for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
    if (repeatedControlCount(current) < 2) continue;
    const kind = inferStructuredEntryKind(repeatSignal(current, adapter));
    if (!kind) continue;
    const selectorMatch = selectors ? current.matches(selectors) : false;
    const semanticClass = /(experience|education|project|award|employment|internship|经历|教育|项目|奖项)/i.test(repeatSignal(current, adapter));
    if (selectorMatch || semanticClass || hasRepeatedSiblingShape(current)) return { root: current, kind };
  }
  return null;
}

function describeRepeatedContext(
  element: FillableElement,
  descriptor: FieldDescriptor,
  adapter: SiteAdapter,
  bindings: RepeatBindingStore,
  groupIds: WeakMap<Element, RepeatGroupIdentity>,
  structureNodeIds: WeakMap<Element, string>,
): RepeatedFieldContext | undefined {
  const found = findRepeatedRoot(element, adapter);
  if (!found) return undefined;
  const field = inferStructuredEntryField(found.kind, [
    descriptor.label,
    descriptor.ariaLabel,
    descriptor.placeholder,
    descriptor.name,
  ].filter(Boolean).join(" | "));
  if (!field) return undefined;
  const siblings = found.root.parentElement
    ? Array.from(found.root.parentElement.children).filter((candidate) => (
      repeatedControlCount(candidate) >= 2 && inferStructuredEntryKind(repeatSignal(candidate, adapter)) === found.kind
    ))
    : [found.root];
  const position = Math.max(0, siblings.indexOf(found.root)) + 1;
  const signature = repeatGroupStructureSignature(
    found.root,
    found.kind,
    position,
    adapter,
    structureNodeIds,
    () => `repeat-node-${nextElementId++}`,
  );
  const { groupKey, targetEntryId } = resolveRepeatGroupIdentity(
    found.root,
    signature,
    groupIds,
    bindings,
    () => `repeat-group-${nextElementId++}`,
  );
  const labels: Record<StructuredEntryKind, string> = { education: "教育经历", experience: "工作 / 实习经历", project: "项目经历", award: "获奖经历" };
  return {
    groupKey,
    groupLabel: `${labels[found.kind]}第 ${position} 行`,
    kind: found.kind,
    field,
    targetEntryId,
  };
}

function scanPage(
  profile: ProfileData,
  elements: Map<string, FillTarget>,
  descriptors: Map<string, FieldDescriptor>,
  adapter: SiteAdapter,
  elementIds: WeakMap<FillableElement, string>,
  mappings: Record<string, ProfileFieldKey>,
  repeatBindings: RepeatBindingStore,
  repeatGroupIds: WeakMap<Element, RepeatGroupIdentity>,
  repeatStructureNodeIds: WeakMap<Element, string>,
): { matches: FieldMatch[]; manualRequired: ManualField[]; manualAttention: ManualField[]; repeatGroups: RepeatGroupPrompt[]; documents: Document[] } {
  elements.clear();
  descriptors.clear();
  const frameScan = collectScanDocuments(document);
  const candidates = frameScan.documents.flatMap((scanDocument) => collectCandidates(scanDocument, adapter));
  const matches: FieldMatch[] = [];
  const manualRequired: ManualField[] = [];
  const manualAttention: ManualField[] = [...frameScan.manualFrames];
  const repeatGroupMap = new Map<string, RepeatGroupPrompt>();
  const processedChoices = new Set<FillableElement>();
  const documentIndexes = new Map(frameScan.documents.map((scanDocument, index) => [scanDocument, index]));
  const semanticCandidates: Array<{
    identity: string;
    ownerDocument: Document;
    profileKey: ProfileFieldKey;
    repeated: boolean;
    matchId?: string;
    label: string;
    required: boolean;
    actionable: boolean;
  }> = [];
  const semanticCandidatesByIdentity = new Map<string, (typeof semanticCandidates)[number]>();

  const candidateIdentity = (anchor: FillableElement, descriptor: FieldDescriptor) => {
    const baseElementId = elementIds.get(anchor) ?? `field-${nextElementId++}`;
    elementIds.set(anchor, baseElementId);
    return {
      baseElementId,
      manualIdentity: [
        `document-${documentIndexes.get(anchor.ownerDocument) ?? 0}`,
        descriptor.repeated?.groupKey ?? "single",
        baseElementId,
      ].join(":"),
      matchId: repeatedMatchIdentity(baseElementId, descriptor.repeated?.groupKey, repeatBindings.epoch),
    };
  };

  const recordSemanticCandidate = (
    anchor: FillableElement,
    descriptor: FieldDescriptor,
    profileKey: ProfileFieldKey,
    identity: string,
    matchId?: string,
    actionable = false,
  ) => {
    const existing = semanticCandidatesByIdentity.get(identity);
    if (existing) {
      existing.profileKey = profileKey;
      existing.repeated = Boolean(descriptor.repeated);
      existing.label ||= (descriptor.label ?? "").slice(0, 100);
      existing.required ||= Boolean(descriptor.required);
      existing.actionable ||= actionable;
      if (matchId) existing.matchId = matchId;
      return;
    }
    const candidate = {
      identity,
      ownerDocument: anchor.ownerDocument,
      profileKey,
      repeated: Boolean(descriptor.repeated),
      ...(matchId ? { matchId } : {}),
      label: (descriptor.label ?? "").slice(0, 100),
      required: Boolean(descriptor.required),
      actionable,
    };
    semanticCandidates.push(candidate);
    semanticCandidatesByIdentity.set(identity, candidate);
  };

  const addSemanticSentinel = (
    anchor: FillableElement,
    identityOverride?: string,
    semanticDescriptor?: FieldDescriptor,
  ): string | undefined => {
    const descriptor = semanticDescriptor ?? describeSemanticField(anchor, adapter);
    if (!descriptor) return undefined;
    descriptor.repeated = describeRepeatedContext(anchor, descriptor, adapter, repeatBindings, repeatGroupIds, repeatStructureNodeIds);
    const explicitKey = descriptor.repeated ? undefined : mappings[descriptorMappingKey(descriptor)];
    const profileKey = semanticProfileKey(descriptor, explicitKey);
    if (!profileKey) return undefined;
    const { manualIdentity } = candidateIdentity(anchor, descriptor);
    const identity = identityOverride ?? manualIdentity;
    recordSemanticCandidate(anchor, descriptor, profileKey, identity);
    return identity;
  };

  const addMatch = (target: FillTarget, anchor: FillableElement, descriptor: FieldDescriptor, identityOverride?: string) => {
    const label = descriptor.label ?? "";
    const explicitKey = descriptor.repeated ? undefined : mappings[descriptorMappingKey(descriptor)];
    const decision = matchDescriptor(descriptor, profile, explicitKey);
    const { manualIdentity, matchId } = candidateIdentity(anchor, descriptor);
    const semanticIdentity = identityOverride ?? manualIdentity;
    if (decision.profileKey) {
      recordSemanticCandidate(
        anchor,
        descriptor,
        decision.profileKey,
        semanticIdentity,
        decision.action === "fill" ? matchId : undefined,
        true,
      );
    }
    if (decision.action !== "fill" || !decision.profileKey || decision.value === null) {
      if (decision.action === "manual") {
        const item = {
          identity: semanticIdentity,
          label: label.slice(0, 100),
          reason: decision.reason,
          required: Boolean(descriptor.required),
        };
        if (descriptor.required) manualRequired.push(item);
        else if (isAttentionReason(decision.reason)) manualAttention.push(item);
      }
      return;
    }
    const id = matchId;
    elements.set(id, target);
    descriptors.set(id, descriptor);
    matches.push({
      id,
      label: label.slice(0, 100) || FIELD_LABELS[decision.profileKey],
      key: decision.profileKey,
      value: decision.sourceValue ?? profile[decision.profileKey],
      resolvedValue: decision.value,
      confidence: decision.confidence,
      kind: elementKind(anchor),
      mappingLocked: Boolean(descriptor.repeated),
      recordLabel: descriptor.repeated?.groupLabel,
      aiPolishable: isAiPolishAllowed(descriptor, decision.profileKey),
    });
  };

  // Inventory every safe ordinary control before the fill pass. This phase
  // never reads value/selection/body state. The later write pass merges by
  // identity, so an eligible field does not appear twice. Named choices are
  // inventoried once per safe scope in their group branch below.
  for (const { element, descriptor } of collectSemanticInventory(candidates, adapter)) {
    addSemanticSentinel(element, undefined, descriptor);
  }

  for (const element of candidates) {
    if (isInputElement(element) && ["radio", "checkbox"].includes(element.type) && element.name) {
      if (processedChoices.has(element)) continue;
      const sameNamedChoices = candidates.filter((candidate): candidate is HTMLInputElement => (
        isInputElement(candidate)
        && candidate.ownerDocument === element.ownerDocument
        && candidate.type === element.type
        && candidate.name === element.name
        && candidate.form === element.form
      ));
      const safeChoiceInventory = sameNamedChoices.flatMap((candidate) => {
        const descriptor = describeSemanticField(candidate, adapter);
        return descriptor ? [{ element: candidate, descriptor }] : [];
      });
      const semanticEntry = safeChoiceInventory.find(({ element: candidate }) => candidate === element);
      if (!semanticEntry) {
        processedChoices.add(element);
        continue;
      }
      const choiceSemanticIdentity = addSemanticSentinel(element, undefined, semanticEntry.descriptor);
      const safeNamedChoices = safeChoiceInventory.map(({ element: candidate }) => candidate);
      if (safeNamedChoices.length !== sameNamedChoices.length) {
        for (const candidate of sameNamedChoices) processedChoices.add(candidate);
        const item: ManualField = {
          identity: choiceSemanticIdentity ?? `document-${documentIndexes.get(element.ownerDocument) ?? 0}:ignored-choice`,
          label: (semanticEntry.descriptor.label ?? "").slice(0, 100),
          reason: "ambiguous_choice_group_scope",
          required: sameNamedChoices.some((candidate) => candidate.hasAttribute("required") || candidate.getAttribute("aria-required") === "true"),
        };
        if (item.required) manualRequired.push(item);
        else manualAttention.push(item);
        continue;
      }
      const scoped = scopeNamedChoiceGroup(
        element,
        safeNamedChoices,
        (candidate) => findRepeatedRoot(candidate, adapter)?.root ?? null,
      );
      for (const candidate of scoped.elements) processedChoices.add(candidate);
      if (scoped.ambiguous) {
        const ambiguousDescriptor = describeField(element, adapter);
        const identityParts = scoped.elements.map((candidate) => {
          const id = elementIds.get(candidate) ?? `field-${nextElementId++}`;
          elementIds.set(candidate, id);
          return id;
        });
        const item: ManualField = {
          identity: `document-${documentIndexes.get(element.ownerDocument) ?? 0}:ambiguous-choice:${identityParts.join("+")}`,
          label: (ambiguousDescriptor.label ?? "").slice(0, 100),
          reason: scoped.reason ?? "ambiguous_choice_group_scope",
          required: scoped.elements.some((candidate) => candidate.hasAttribute("required") || candidate.getAttribute("aria-required") === "true"),
        };
        if (item.required) manualRequired.push(item);
        else manualAttention.push(item);
        continue;
      }
      // Scope by repeat/container identity before considering eligibility. A
      // disabled row must never borrow a writable option from its sibling and
      // then reuse the disabled row's semantic identity.
      const group = scoped.elements.filter((candidate) => !isIgnoredByAdapter(candidate, adapter) && isEligible(candidate, adapter));
      if (!group.length) continue;
      const descriptor = describeField(group[0], adapter);
      descriptor.repeated = describeRepeatedContext(group[0], descriptor, adapter, repeatBindings, repeatGroupIds, repeatStructureNodeIds);
      registerRepeatGroup(descriptor.repeated, profile, repeatGroupMap);
      descriptor.controlType = element.type as "radio" | "checkbox";
      descriptor.multiple = element.type === "checkbox";
      descriptor.options = group.map((candidate) => ({
        label: optionLabel(candidate, adapter),
        value: candidate.value,
        disabled: candidate.disabled,
      }));
      addMatch(group, group[0], descriptor, choiceSemanticIdentity);
      continue;
    }
    if (isIgnoredByAdapter(element, adapter) || !isEligible(element, adapter)) continue;
    const descriptor = describeField(element, adapter);
    descriptor.repeated = describeRepeatedContext(element, descriptor, adapter, repeatBindings, repeatGroupIds, repeatStructureNodeIds);
    registerRepeatGroup(descriptor.repeated, profile, repeatGroupMap);
    addMatch(element, element, descriptor);
  }
  const {
    blockedIds: duplicateSemanticIdentities,
    reportIds: duplicateSemanticReportIdentities,
  } = resolveDuplicateSemanticCandidates(semanticCandidates);
  const duplicateMatchIds = new Set<string>();
  const removeManualIdentity = (items: ManualField[], identity: string) => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].identity === identity) items.splice(index, 1);
    }
  };
  for (const candidate of semanticCandidates) {
    if (!duplicateSemanticIdentities.has(candidate.identity)) continue;
    if (candidate.matchId) {
      duplicateMatchIds.add(candidate.matchId);
      elements.delete(candidate.matchId);
      descriptors.delete(candidate.matchId);
    }
    if (!duplicateSemanticReportIdentities.has(candidate.identity)) continue;
    removeManualIdentity(manualRequired, candidate.identity);
    removeManualIdentity(manualAttention, candidate.identity);
    const item: ManualField = {
      identity: candidate.identity,
      label: candidate.label,
      reason: "duplicate_semantic_requires_user_action",
      required: candidate.required,
    };
    if (item.required) manualRequired.push(item);
    else manualAttention.push(item);
  }
  const activeRepeatGroups = new Set(repeatGroupMap.keys());
  for (const groupKey of repeatBindings.keys()) {
    if (!activeRepeatGroups.has(groupKey)) repeatBindings.delete(groupKey);
  }
  return {
    matches: deduplicate(matches.filter((match) => !duplicateMatchIds.has(match.id))),
    manualRequired: deduplicateManualFields(manualRequired),
    manualAttention: deduplicateManualFields(manualAttention),
    repeatGroups: [...repeatGroupMap.values()],
    documents: frameScan.documents,
  };
}

function registerRepeatGroup(
  context: RepeatedFieldContext | undefined,
  profile: ProfileData,
  groups: Map<string, RepeatGroupPrompt>,
) {
  if (!context || groups.has(context.groupKey)) return;
  groups.set(context.groupKey, {
    groupKey: context.groupKey,
    groupLabel: context.groupLabel,
    kind: context.kind,
    selectedEntryId: context.targetEntryId,
    options: structuredEntryOptions(profile, context.kind),
  });
}

function isAttentionReason(reason: string): boolean {
  return [
    "attachment_user_required",
    "dynamic_choice_requires_user_action",
    "repeated_group_unbound",
    "repeated_group_target_missing",
    "unsupported_repeated_field",
    "date_precision_insufficient",
    "cross_origin_iframe",
    "iframe_not_ready",
    "ambiguous_choice_group_scope",
    "choice_group_has_existing_selection",
    "radio_group_crosses_repeat_roots",
    "duplicate_semantic_requires_user_action",
  ].includes(reason);
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
    date_precision_insufficient: "档案只有年月，页面要求完整日期，请人工确认具体日期",
    attachment_user_required: "附件必须由你核对后手动选择",
    dynamic_choice_requires_user_action: "动态下拉未验证选项与事件链，保持人工选择",
    repeated_group_unbound: "重复经历行尚未绑定结构化档案记录",
    repeated_group_target_missing: "已绑定的档案记录不存在，请重新选择",
    unsupported_repeated_field: "重复经历中的该字段暂不支持",
    cross_origin_iframe: "跨域 iframe 无法读取，必须人工检查",
    iframe_not_ready: "iframe 尚未加载完成，请稍后重新识别",
    ambiguous_choice_group_scope: "同名单选或多选控件无法唯一归属到一个表单行，保持整组人工处理",
    choice_group_has_existing_selection: "同名选择组已有页面选项，保持整组人工处理以免覆盖",
    radio_group_crosses_repeat_roots: "原生单选组跨越多个重复行，浏览器会跨行互斥，保持整组人工处理",
    duplicate_semantic_requires_user_action: "同一页面存在重复语义字段且至少一项未识别为重复行，保持整组人工处理",
  };
  return messages[reason] ?? "需要人工确认";
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").replace(/[*：:]+$/g, "").trim();
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
  if (isTextareaElement(element)) return "textarea";
  if (isSelectElement(element)) return "select";
  if (isInputElement(element) && element.type === "radio") return "radio";
  if (isInputElement(element) && element.type === "checkbox") return "checkbox";
  if (isInputElement(element)) return "input";
  return "contenteditable";
}

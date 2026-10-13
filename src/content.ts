import panelCss from "./content.css?inline";
import { boundedDiagnostics, DIAGNOSTIC_VENDORS, formatDiagnostics, type DiagnosticCount, type DiagnosticEvent, type DiagnosticOutcome, type DiagnosticReason } from "./diagnostics";
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
import { classifyRecruitmentPage } from "./page-classifier";
import { profileEntry } from "./profile-entry";
import {
  normalizeProfileFillPlan,
  publishedProfileRevision,
  toRemoteDetectedField,
  type RemoteProfileStatus,
} from "./remote-autofill";
import { inferStructuredEntryField, inferStructuredEntryKind, structuredEntryOptions, type StructuredEntryOption } from "./repeat-context.ts";
import { getSiteAdapter, isIgnoredByAdapter, staticLabelTextOutsideControls, type SiteAdapter } from "./site-adapters";
import { applicationWriteAllowed } from "./write-policy";
import { EMPTY_PROFILE, type FieldMatch, type ProfileData, type ProfileFieldKey, type RepeatedFieldContext, type StoredState, type StructuredEntryKind } from "./types";

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

interface SafeFieldInventoryItem {
  id: string;
  descriptor: FieldDescriptor;
}

interface ScanPageResult {
  matches: FieldMatch[];
  manualRequired: ManualField[];
  manualAttention: ManualField[];
  repeatGroups: RepeatGroupPrompt[];
  documents: Document[];
  inventory: SafeFieldInventoryItem[];
  stats: { documents: number; controls: number; semantic: number; recognized: number; existing: number };
}

type DataSourceMode = "remote" | "local";

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
    <button class="gugu-bubble gugu-hidden" title="打开谷谷网申助手" aria-label="打开谷谷网申助手">谷</button>
    <aside class="gugu-panel gugu-hidden" aria-label="谷谷网申助手">
      <header class="gugu-header">
        <div class="gugu-brand"><span class="gugu-logo">谷</span><span class="gugu-title"><strong>谷谷网申助手</strong><small>先预览，再填写</small></span></div>
        <button class="gugu-icon-button" data-action="close" aria-label="关闭">×</button>
      </header>
      <section class="gugu-summary"><div class="gugu-progress"><strong data-role="count">正在识别…</strong><span class="gugu-tier" data-role="tier">服务端资料</span></div><p>默认只处理空白且可见的字段；不会点击“提交”或同意协议。</p><p class="gugu-write-guard gugu-hidden" data-role="write-guard">北森表单现场发现字段错配，本版本已暂停写入。仍可查看预览与诊断；请手动核对已改动的页面字段，不要提交错误资料。</p><label class="gugu-overwrite"><input type="checkbox" data-action="overwrite-existing" />覆盖已有文字（仅普通文本框，写入前逐项预览，可撤销）</label></section>
      <section class="gugu-source" data-role="source"></section>
      <div class="gugu-list" data-role="list"></div>
      <details class="gugu-diagnostics" data-role="diagnostics"><summary>诊断日志</summary><p>仅保存在本机扩展会话中，不记录网址、表单内容或个人资料。</p><pre data-role="diagnostic-lines"></pre><div class="gugu-diagnostic-actions"><button type="button" data-action="copy-diagnostics">复制诊断</button><button type="button" data-action="clear-diagnostics">清空日志</button></div></details>
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
  const source = root.querySelector<HTMLElement>("[data-role=source]")!;
  const fillButton = root.querySelector<HTMLButtonElement>("[data-action=fill]")!;
  const undoButton = root.querySelector<HTMLButtonElement>("[data-action=undo]")!;
  const overwriteCheckbox = root.querySelector<HTMLInputElement>("[data-action=overwrite-existing]")!;
  const writeGuard = root.querySelector<HTMLElement>("[data-role=write-guard]")!;
  const diagnosticDetails = root.querySelector<HTMLDetailsElement>("[data-role=diagnostics]")!;
  const diagnosticLines = root.querySelector<HTMLElement>("[data-role=diagnostic-lines]")!;
  const elements = new Map<string, FillTarget>();
  const descriptors = new Map<string, FieldDescriptor>();
  const elementIds = new WeakMap<FillableElement, string>();
  const repeatGroupIds = new WeakMap<Element, RepeatGroupIdentity>();
  const repeatStructureNodeIds = new WeakMap<Element, string>();
  const adapter = getSiteAdapter();
  const diagnosticVendor = DIAGNOSTIC_VENDORS.find((vendor) => vendor === adapter.id) ?? "generic";
  const writesAllowed = applicationWriteAllowed(adapter.id);
  writeGuard.classList.toggle("gugu-hidden", writesAllowed);
  let state: StoredState | null = null;
  let dataSource: DataSourceMode = "remote";
  let authenticated = false;
  let accountDisplayName = "";
  let remoteProfileStatus: RemoteProfileStatus | null = null;
  let profileErrorStatus: number | null = null;
  let baseStateLoaded = false;
  let emptyHint = "请选择资料来源后生成填写预览。";
  let matches: FieldMatch[] = [];
  let manualRequired: ManualField[] = [];
  let manualAttention: ManualField[] = [];
  let repeatGroups: RepeatGroupPrompt[] = [];
  const repeatBindings = new RepeatBindingStore();
  let savedMappings: Record<string, ProfileFieldKey> = {};
  let selectedIds = new Set<string>();
  let hasRenderedOnce = false;
  let lastFill: ElementSnapshot[] = [];
  let overwriteExisting = false;
  let previewOverwriteExisting = false;
  const previewOriginalValues = new Map<string, ElementSnapshot[]>();
  let panelOpen = false;
  let refreshTimer: number | undefined;
  let pageObservers: MutationObserver[] = [];
  let pageActivityCleanups: Array<() => void> = [];
  let assistantWriteInProgress = false;
  let manualSurface = false;
  let lastSurfaceLocation = "";
  let refreshGeneration = 0;
  let previewGeneration = 0;
  let previewLocation = "";
  let refreshInProgress = false;

  function showNotice(message: string, error = false) {
    notice.textContent = message;
    notice.classList.toggle("error", error);
  }

  async function loadDiagnostics() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_DIAGNOSTICS" }) as { ok?: boolean; result?: unknown };
      diagnosticLines.textContent = response.ok
        ? formatDiagnostics(boundedDiagnostics(response.result))
        : "暂时无法读取诊断日志。";
    } catch { diagnosticLines.textContent = "暂时无法读取诊断日志。"; }
  }

  function logDiagnostic(event: DiagnosticEvent, outcome: DiagnosticOutcome, reason: DiagnosticReason = "none", counts: Partial<Record<DiagnosticCount, number>> = {}) {
    void chrome.runtime.sendMessage({
      type: "RECORD_DIAGNOSTIC", diagnostic: { event, outcome, reason, vendor: diagnosticVendor, counts },
    }).then(() => { if (diagnosticDetails.open) void loadDiagnostics(); }).catch(() => undefined);
  }

  diagnosticDetails.addEventListener("toggle", () => { if (diagnosticDetails.open) void loadDiagnostics(); });

  function escapeHtml(value: string) {
    return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
  }

  function hasLocalProfile(): boolean {
    return Boolean(state && (state.profile.fullName || state.profile.phone || state.profile.email || state.profile.resumeRawText));
  }

  function renderSource() {
    if (!authenticated) {
      source.innerHTML = `<div class="gugu-source-copy"><strong>登录后使用网申资料</strong><span>登录凭据只由扩展后台保管，不会交给招聘页面</span></div>
        <div class="gugu-source-actions">
          <button class="gugu-inline-button gugu-accent" data-action="login" type="button">登录谷谷账号</button>
          <button class="gugu-inline-button" data-action="check-auth" type="button">我已登录，重新检查</button>
        </div>`;
      return;
    }
    const entry = profileEntry(remoteProfileStatus, profileErrorStatus);
    source.innerHTML = `<div class="gugu-source-copy"><strong>${escapeHtml(accountDisplayName || "已登录谷谷账号")}${escapeHtml(entry.statusLabel)}</strong><span>${escapeHtml(entry.guidance)}</span>${remoteProfileStatus?.publishedStatus === "active" && (remoteProfileStatus.hasPendingImport || remoteProfileStatus.hasUnpublishedDraft) ? "<span>网站有尚未写入或保存的更新，本次仍使用当前已保存版本。</span>" : ""}</div>
      <div class="gugu-source-actions">
        <button class="gugu-inline-button gugu-accent" data-action="${entry.action}" type="button">${escapeHtml(entry.actionLabel)}</button>
        <button class="gugu-inline-button" data-action="logout" type="button">退出助手账号</button>
      </div>`;
  }

  function render() {
    renderSource();
    overwriteCheckbox.checked = overwriteExisting;
    overwriteCheckbox.disabled = dataSource !== "remote" || !authenticated || !remoteProfileStatus?.publishedRevision;
    count.textContent = `${writesAllowed ? "可填写" : "预览候选"} ${matches.length} 个 · 必填需人工 ${manualRequired.length} 个 · 其他需确认 ${manualAttention.length} 个 · ${adapter.name}`;
    tier.textContent = remoteProfileStatus?.publishedRevision ? `服务端资料 v${remoteProfileStatus.publishedRevision}` : "服务端资料";
    fillButton.disabled = !writesAllowed || matches.length === 0 || refreshInProgress || previewGeneration !== refreshGeneration || previewLocation !== location.href;
    fillButton.textContent = writesAllowed ? "填写已选字段" : "北森写入暂停";
    undoButton.classList.toggle("gugu-hidden", lastFill.length === 0);
    const repeatSummary = repeatGroups.length
      ? `<div class="gugu-manual"><strong>重复经历必须先绑定档案记录</strong>${repeatGroups.map((group) => `<label>${escapeHtml(group.groupLabel)}<select data-action="bind-entry" data-group-key="${escapeHtml(group.groupKey)}" data-scan-epoch="${repeatBindings.epoch}"><option value="">请选择，不会默认使用第一条</option>${group.options.map((option) => `<option value="${escapeHtml(option.id)}" ${option.id === group.selectedEntryId ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></label>`).join("")}</div>`
      : "";
    const manualItems = [...manualRequired, ...manualAttention];
    const manualSummary = manualItems.length
      ? `<div class="gugu-manual"><strong>以下控件不会自动处理</strong>${manualItems.map((item) => `<p>${escapeHtml(item.label || "未命名字段")} · ${item.required ? "必填 · " : ""}${escapeHtml(manualReason(item.reason))}</p>`).join("")}</div>`
      : "";
    if (!matches.length) {
      list.innerHTML = `<p class="gugu-empty">${escapeHtml(emptyHint)}</p>${repeatSummary}${manualSummary}`;
      return;
    }
    list.innerHTML = matches.map((match) => {
      const canPolish = match.source !== "remote" && state?.ai.enabled && match.aiPolishable && match.value.length >= 12;
      const displayValue = match.suggestedValue ?? match.value;
      const suggestion = match.suggestedValue
        ? `<small class="gugu-original">原文：${escapeHtml(match.value)}</small><textarea class="gugu-suggestion" data-action="edit-suggestion" aria-label="编辑 AI 建议">${escapeHtml(displayValue)}</textarea>${(match.factWarnings ?? []).map((warning) => `<small class="gugu-warning">⚠ ${escapeHtml(warning)}</small>`).join("")}`
        : `<span class="gugu-field-value" title="${escapeHtml(displayValue)}">${escapeHtml(displayValue) || "档案中暂无该字段"}</span>`;
      const checked = selectedIds.has(match.id);
      const mappingControl = match.source === "remote"
        ? `<span class="gugu-record-source">已保存资料${match.canonicalKey ? ` · ${escapeHtml(match.canonicalKey)}` : ""}${descriptors.get(match.id)?.hasValue ? " · 将覆盖已有文字" : ""}${match.sensitivity === "conditional" ? " · 条件信息，默认不选" : ""}</span>`
        : match.mappingLocked
          ? `<span class="gugu-record-source">${escapeHtml(match.recordLabel ?? "已绑定结构化记录")}</span>`
          : match.key
            ? `<select class="gugu-key-select" data-action="map" aria-label="将${escapeHtml(match.label)}映射为">${fieldOptions(match.key)}</select>`
            : `<span class="gugu-record-source">需人工确认</span>`;
      return `<div class="gugu-row" data-id="${match.id}">
        <input class="gugu-check" type="checkbox" ${checked ? "checked" : ""} aria-label="填写${escapeHtml(match.label)}" />
        <span class="gugu-field"><span class="gugu-field-label" title="${escapeHtml(match.label)}">${escapeHtml(match.label)}</span>${mappingControl}${suggestion}</span>
        <span class="gugu-confidence ${match.confidence < 0.78 ? "medium" : ""}">${Math.round(match.confidence * 100)}%</span>
        ${canPolish ? `<button class="gugu-ai" data-action="polish" type="button">AI 润色此项</button>` : ""}
      </div>`;
    }).join("") + repeatSummary + manualSummary;
  }

  async function loadBaseState(force = false) {
    if (!force && baseStateLoaded && state) return;
    const response = await chrome.runtime.sendMessage({ type: "GET_ASSISTANT_STATE" }) as { ok: boolean; state?: StoredState; error?: string };
    if (!response.ok || !response.state) throw new Error(response.error || "无法读取个人档案");
    state = response.state;
    savedMappings = await loadSiteMappings();
    baseStateLoaded = true;
  }

  async function refreshAuthState() {
    const response = await chrome.runtime.sendMessage({ type: "GET_AUTOFILL_SESSION" }) as {
      ok?: boolean;
      result?: { authenticated?: boolean; displayName?: string };
      error?: string;
    };
    if (!response.ok) throw new Error(response.error || "无法检查登录状态。 ");
    authenticated = response.result?.authenticated === true;
    accountDisplayName = response.result?.displayName ?? "";
    if (!authenticated) {
      remoteProfileStatus = null;
      profileErrorStatus = null;
      return;
    }
    const status = await chrome.runtime.sendMessage({ type: "GET_PROFILE_STATUS" }) as {
      ok?: boolean;
      result?: RemoteProfileStatus;
      error?: string;
      status?: number;
    };
    if (!status.ok) {
      remoteProfileStatus = null;
      profileErrorStatus = typeof status.status === "number" ? status.status : null;
      if (status.status === 401) {
        authenticated = false;
        accountDisplayName = "";
        remoteProfileStatus = null;
      }
      throw new Error(status.error || "无法读取网申资料状态。");
    }
    remoteProfileStatus = status.result ?? null;
    profileErrorStatus = null;
  }

  function stopScanObservers() {
    for (const observer of pageObservers) observer.disconnect();
    for (const cleanup of pageActivityCleanups) cleanup();
    pageObservers = [];
    pageActivityCleanups = [];
    window.clearTimeout(refreshTimer);
  }

  function clearPreview(hint: string) {
    refreshGeneration += 1;
    refreshInProgress = false;
    previewGeneration = 0;
    previewLocation = "";
    stopScanObservers();
    elements.clear();
    descriptors.clear();
    previewOriginalValues.clear();
    previewOverwriteExisting = false;
    matches = [];
    manualRequired = [];
    manualAttention = [];
    repeatGroups = [];
    selectedIds.clear();
    hasRenderedOnce = false;
    emptyHint = hint;
    render();
  }

  const remoteStructuralReasons = new Set([
    "attachment_user_required", "dynamic_choice_requires_user_action", "repeated_group_unbound",
    "repeated_group_target_missing", "unsupported_repeated_field", "cross_origin_iframe", "iframe_not_ready",
    "ambiguous_choice_group_scope", "choice_group_has_existing_selection", "radio_group_crosses_repeat_roots",
    "duplicate_semantic_requires_user_action",
  ]);

  function installScanObservers(scan: ScanPageResult, generation: number) {
    observeDocuments(scan.documents, host, () => {
      if (generation !== refreshGeneration) return;
      invalidateRepeatSnapshot();
      if (!panelOpen) return;
      const invalidatedGeneration = ++refreshGeneration;
      refreshInProgress = true;
      fillButton.disabled = true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (invalidatedGeneration !== refreshGeneration) return;
        void refresh().then(() => showNotice("页面已变化，识别结果已更新。"), (error) => showNotice(error instanceof Error ? error.message : "动态字段识别失败", true));
      }, 350);
    }, () => {
      if (generation !== refreshGeneration) return;
      if (assistantWriteInProgress) return;
      invalidateRepeatSnapshot();
      if (!panelOpen) return;
      const invalidatedGeneration = ++refreshGeneration;
      refreshInProgress = true;
      fillButton.disabled = true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (invalidatedGeneration !== refreshGeneration) return;
        void refresh().then(() => showNotice("页面字段发生输入或选择，预览已更新。"), (error) => showNotice(error instanceof Error ? error.message : "动态字段识别失败", true));
      }, 150);
    }, () => {
      if (generation !== refreshGeneration) return;
      invalidateRepeatSnapshot();
      if (!panelOpen) return;
      const invalidatedGeneration = ++refreshGeneration;
      refreshInProgress = true;
      fillButton.disabled = true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (invalidatedGeneration !== refreshGeneration) return;
        void refresh().then(() => showNotice("iframe 已加载，表单控件已重新检查。"), (error) => showNotice(error instanceof Error ? error.message : "iframe 识别失败", true));
      }, 100);
    });
  }

  async function refresh() {
    const generation = ++refreshGeneration;
    const sourceAtStart = dataSource;
    const overwriteAtStart = sourceAtStart === "remote" && overwriteExisting;
    const revisionAtStart = publishedProfileRevision(remoteProfileStatus);
    const selectedAtStart = new Set(selectedIds);
    const hadRenderedAtStart = hasRenderedOnce;
    const localElements = new Map<string, FillTarget>();
    const localDescriptors = new Map<string, FieldDescriptor>();
    const isCurrent = () => (
      generation === refreshGeneration
      && dataSource === sourceAtStart
      && (sourceAtStart !== "remote" || overwriteExisting === overwriteAtStart)
      && (sourceAtStart !== "remote" || publishedProfileRevision(remoteProfileStatus) === revisionAtStart)
    );
    const commit = (
      nextMatches: FieldMatch[],
      nextManualRequired: ManualField[],
      nextManualAttention: ManualField[],
      nextRepeatGroups: RepeatGroupPrompt[],
      nextEmptyHint: string,
    ) => {
      if (!isCurrent()) return false;
      elements.clear();
      for (const [id, target] of localElements) elements.set(id, target);
      descriptors.clear();
      for (const [id, descriptor] of localDescriptors) descriptors.set(id, descriptor);
      previewOriginalValues.clear();
      for (const match of nextMatches) {
        const target = localElements.get(match.id);
        if (target && localDescriptors.get(match.id)?.hasValue) previewOriginalValues.set(match.id, snapshotTarget(target));
      }
      previewOverwriteExisting = overwriteAtStart;
      matches = nextMatches;
      manualRequired = nextManualRequired;
      manualAttention = nextManualAttention;
      repeatGroups = nextRepeatGroups;
      emptyHint = nextEmptyHint;
      selectedIds = new Set(matches
        .filter((match) => hadRenderedAtStart ? selectedAtStart.has(match.id) : match.confidence >= 0.78 && match.sensitivity !== "conditional")
        .map((match) => match.id));
      hasRenderedOnce = true;
      previewGeneration = generation;
      previewLocation = location.href;
      refreshInProgress = false;
      render();
      return true;
    };

    refreshInProgress = true;
    fillButton.disabled = true;
    stopScanObservers();
    showNotice("");
    try {
      if (sourceAtStart === "local") await loadBaseState(true);
      if (!isCurrent()) return;

      if (sourceAtStart === "remote" && !authenticated) {
        commit([], [], [], [], "请先登录谷谷账号。");
        return;
      }
      if (sourceAtStart === "remote" && !remoteProfileStatus) {
        commit([], [], [], [], "网申资料服务暂不可用。请稍后重新检查，当前不会填写页面。");
        return;
      }
      if (sourceAtStart === "remote" && !revisionAtStart) {
        commit([], [], [], [], "尚无可用的网申资料。请先在谷谷网站上传简历并一键写入，或手工填写后保存。");
        return;
      }
      if (sourceAtStart === "local" && !hasLocalProfile()) {
        commit([], [], [], [], "当前浏览器没有可用档案，请先编辑本地档案。 ");
        return;
      }

      const scan = scanPage(
        sourceAtStart === "remote" ? EMPTY_PROFILE : state!.profile,
        localElements,
        localDescriptors,
        adapter,
        elementIds,
        savedMappings,
        repeatBindings,
        repeatGroupIds,
        repeatStructureNodeIds,
        sourceAtStart === "remote" ? remoteProfileStatus?.recordOptions : undefined,
        overwriteAtStart,
      );
      installScanObservers(scan, generation);
      const scanCounts: Partial<Record<DiagnosticCount, number>> = {
        ...scan.stats,
        inventory: scan.inventory.length,
        manualRequired: scan.manualRequired.length,
        manualOther: scan.manualAttention.length,
        ...manualDiagnosticCounts([...scan.manualRequired, ...scan.manualAttention]),
      };
      const emptyReason: DiagnosticReason = scan.stats.controls === 0 ? "no_controls"
        : scan.stats.semantic === 0 ? "no_semantics"
          : scan.manualRequired.length + scan.manualAttention.length > 0 ? "manual_only"
            : scan.stats.existing > 0 && !overwriteAtStart ? "existing_values" : "no_plan_match";
      if (isCurrent()) logDiagnostic("scan", scan.inventory.length ? "ok" : "empty", scan.inventory.length ? "none" : emptyReason, scanCounts);

      if (sourceAtStart === "remote") {
        const fields = scan.inventory.flatMap((item) => {
          const remote = toRemoteDetectedField(item.id, item.descriptor);
          return remote ? [remote] : [];
        });
        if (!fields.length) {
          if (isCurrent()) logDiagnostic("plan", "empty", emptyReason, scanCounts);
          commit(
            [],
            scan.manualRequired.filter((item) => remoteStructuralReasons.has(item.reason)),
            scan.manualAttention.filter((item) => remoteStructuralReasons.has(item.reason)),
            [],
            overwriteAtStart
              ? "暂未找到账号资料可以安全匹配的文本字段。动态下拉、附件和重复经历会保留人工处理。"
              : "暂未找到账号资料可以安全处理的空白字段。动态下拉、附件和重复经历会保留人工处理。",
          );
          return;
        }

        const response = await chrome.runtime.sendMessage({
          type: "CREATE_PROFILE_PLAN",
          revision: revisionAtStart,
          vendor: adapter.id,
          fields,
          ...(overwriteAtStart ? { overwriteExisting: true } : {}),
        }) as { ok?: boolean; result?: unknown; error?: string; status?: number };
        if (!isCurrent()) return;
        if (!response.ok) {
          if (response.status === 401) {
            authenticated = false;
            accountDisplayName = "";
            remoteProfileStatus = null;
          }
          throw new Error(response.error || "无法生成网申资料填写计划。");
        }
        const plan = normalizeProfileFillPlan(response.result, new Map(fields.map((field) => [field.fieldId, field])), revisionAtStart, adapter.id, overwriteAtStart);
        const inventoryById = new Map(scan.inventory.map((item) => [item.id, item]));
        const nextMatches = plan.decisions.flatMap((decision): FieldMatch[] => {
          const item = inventoryById.get(decision.fieldId);
          const target = localElements.get(decision.fieldId);
          if (!item || !target || decision.action !== "fill" || decision.value === null) return [];
          const anchor = Array.isArray(target) ? target[0] : target;
          if (!anchor) return [];
          const displayValue = Array.isArray(decision.value) ? decision.value.join("、") : decision.value;
          return [{
            id: decision.fieldId,
            source: "remote",
            canonicalKey: decision.canonicalKey ?? undefined,
            label: (item.descriptor.label ?? item.descriptor.ariaLabel ?? item.descriptor.placeholder ?? "未命名字段").slice(0, 100),
            value: displayValue,
            resolvedValue: decision.value,
            confidence: decision.confidence,
            sensitivity: decision.sensitivity,
            kind: elementKind(anchor),
            mappingLocked: true,
            aiPolishable: false,
          }];
        });
        const planManual = plan.decisions.flatMap((decision): ManualField[] => {
          const item = inventoryById.get(decision.fieldId);
          if (!item || decision.action !== "manual") return [];
          return [{
            identity: decision.fieldId,
            label: (item.descriptor.label ?? item.descriptor.ariaLabel ?? item.descriptor.placeholder ?? "未命名字段").slice(0, 100),
            reason: decision.reason,
            required: Boolean(item.descriptor.required),
          }];
        });
        const structuralRequired = scan.manualRequired.filter((item) => remoteStructuralReasons.has(item.reason));
        const structuralAttention = scan.manualAttention.filter((item) => remoteStructuralReasons.has(item.reason));
        const nextManualRequired = deduplicateManualFields([...structuralRequired, ...planManual.filter((item) => item.required)]);
        const nextManualAttention = deduplicateManualFields([...structuralAttention, ...planManual.filter((item) => !item.required)]);
        const allManual = [...nextManualRequired, ...nextManualAttention];
        if (isCurrent()) logDiagnostic("plan", nextMatches.length ? "ok" : "empty",
          nextMatches.length ? "none" : allManual.length ? "manual_only" : scan.stats.existing > 0 && !overwriteAtStart ? "existing_values" : "no_plan_match",
          { inventory: fields.length, fillable: nextMatches.length,
            manualRequired: nextManualRequired.length,
            manualOther: nextManualAttention.length,
            ...manualDiagnosticCounts(allManual) });
        commit(
          nextMatches,
          nextManualRequired,
          nextManualAttention,
          scan.repeatGroups,
          "当前没有可直接填写的空白字段。页面已有文字默认跳过；可勾选上方普通文本覆盖后重新识别，动态下拉和附件仍需人工处理。",
        );
      } else {
        commit(
          scan.matches,
          scan.manualRequired,
          scan.manualAttention,
          scan.repeatGroups,
          "暂未找到能够可靠匹配的空白字段。可滚动页面让动态表单加载后，再重新识别。",
        );
      }
    } catch (error) {
      if (isCurrent()) {
        logDiagnostic("plan", "failed", error instanceof TypeError ? "network" : "server");
        elements.clear();
        descriptors.clear();
        previewOriginalValues.clear();
        matches = [];
        manualRequired = [];
        manualAttention = [];
        repeatGroups = [];
        selectedIds.clear();
        hasRenderedOnce = false;
        emptyHint = "本次预览未生成，请检查提示后重试。";
        previewGeneration = 0;
        render();
      }
      throw error;
    } finally {
      if (generation === refreshGeneration) refreshInProgress = false;
    }
  }

  async function open() {
    clearPreview("正在检查登录状态和当前页面。 ");
    invalidateRepeatSnapshot();
    panelOpen = true;
    panel.classList.remove("gugu-hidden");
    bubble.classList.add("gugu-hidden");
    try {
      await refreshAuthState();
      logDiagnostic("auth", authenticated ? remoteProfileStatus?.publishedRevision ? "ok" : "empty" : "blocked",
        authenticated ? remoteProfileStatus?.publishedRevision ? "none" : "profile_missing" : "login_required");
      await refresh();
    } catch (error) {
      logDiagnostic("auth", "failed", authenticated ? "profile_unavailable" : "login_required");
      clearPreview("无法载入网申资料，已停止识别与填写。");
      showNotice(error instanceof Error ? error.message : "识别失败", true);
    }
  }

  function close() {
    overwriteExisting = false;
    previewOriginalValues.clear();
    previewOverwriteExisting = false;
    panelOpen = false;
    panel.classList.add("gugu-hidden");
    updateAutomaticSurface();
  }

  root.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    const action = button?.dataset.action;
    if (button === bubble) return open();
    if (action === "close") return close();
    if (action === "copy-diagnostics") {
      try {
        await navigator.clipboard.writeText(diagnosticLines.textContent ?? "");
        showNotice("已复制不含表单内容的诊断日志。 ");
      } catch { showNotice("复制失败，请手动选中诊断文字复制。", true); }
      return;
    }
    if (action === "clear-diagnostics") {
      try {
        await chrome.runtime.sendMessage({ type: "CLEAR_DIAGNOSTICS" });
        await loadDiagnostics();
        showNotice("本机诊断日志已清空。 ");
      } catch { showNotice("暂时无法清空诊断日志。", true); }
      return;
    }
    if (action === "login") {
      dataSource = "remote";
      clearPreview("正在打开谷谷登录页；登录完成后会重新载入网申资料。");
      const response = await chrome.runtime.sendMessage({ type: "BEGIN_AUTOFILL_LOGIN" }) as { ok?: boolean; error?: string };
      if (response.ok) showNotice("已打开谷谷登录页。登录完成后返回此页，助手会自动更新；也可以点“重新检查”。");
      else showNotice(response.error || "无法打开登录页。", true);
      render();
      return;
    }
    if (action === "check-auth") {
      try {
        await refreshAuthState();
        render();
        if (authenticated) {
          await refresh();
          showNotice(remoteProfileStatus?.publishedRevision ? "登录状态已同步，填写预览已生成。" : "登录状态已同步，请先在网站写入或保存网申资料。");
        }
        else showNotice("仍未检测到有效登录，请在刚打开的谷谷页面完成登录。", true);
      } catch (error) {
        clearPreview("无法载入网申资料，已停止识别与填写。");
        showNotice(error instanceof Error ? error.message : "登录状态检查失败。", true);
      }
      return;
    }
    if (action === "use-local") {
      dataSource = "local";
      hasRenderedOnce = false;
      invalidateRepeatSnapshot();
      try { await refresh(); } catch (error) { showNotice(error instanceof Error ? error.message : "本地档案识别失败", true); }
      return;
    }
    if (action === "use-remote") {
      dataSource = "remote";
      hasRenderedOnce = false;
      invalidateRepeatSnapshot();
      try { await refresh(); } catch (error) { showNotice(error instanceof Error ? error.message : "账号简历预览失败", true); }
      return;
    }
    if (action === "edit-profile") {
      const response = await chrome.runtime.sendMessage({ type: "OPEN_PROFILE_PAGE" }) as { ok?: boolean; error?: string };
      if (!response.ok) showNotice(response.error || "无法打开网申资料页。", true);
      return;
    }
    if (action === "logout") {
      clearPreview("正在退出助手账号。 ");
      const response = await chrome.runtime.sendMessage({ type: "LOGOUT_AUTOFILL" }) as { ok?: boolean; error?: string };
      if (!response.ok) {
        showNotice(response.error || "退出失败。", true);
        return;
      }
      authenticated = false;
      accountDisplayName = "";
      remoteProfileStatus = null;
      profileErrorStatus = null;
      dataSource = "remote";
      clearPreview("已退出助手账号。请重新登录。");
      showNotice("已清除扩展会话中的助手登录凭据。 ");
      return;
    }
    if (action === "rescan") {
      invalidateRepeatSnapshot();
      try {
        if (dataSource === "remote") await refreshAuthState();
        await refresh();
      } catch (error) {
        clearPreview("无法载入网申资料，已停止识别与填写。");
        showNotice(error instanceof Error ? error.message : "识别失败", true);
      }
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
      logDiagnostic("undo", "ok", "none", { written: restored });
      invalidateRepeatSnapshot();
      try { await refresh(); } catch (error) { showNotice(error instanceof Error ? error.message : "撤销后重新识别失败", true); return; }
      showNotice(`已撤销 ${restored} 项填写；重复经历需重新绑定。`);
      return;
    }
    if (action === "fill") {
      if (!writesAllowed) {
        logDiagnostic("fill", "blocked", "vendor_write_paused");
        showNotice("北森字段错配修复前已暂停写入，请手动核对页面资料。", true);
        return;
      }
      if (refreshInProgress || previewGeneration !== refreshGeneration || previewLocation !== location.href || previewOverwriteExisting !== overwriteExisting) {
        logDiagnostic("fill", "blocked", "stale_preview");
        showNotice("页面正在重新识别，请等待当前预览生成后再填写。", true);
        return;
      }
      const expectedRevision = remoteProfileStatus?.publishedRevision;
      if (dataSource === "remote") {
        const validation = await chrome.runtime.sendMessage({ type: "VALIDATE_PROFILE_REVISION", revision: expectedRevision }) as { ok?: boolean; result?: boolean; error?: string };
        if (!validation.ok || validation.result !== true || previewGeneration !== refreshGeneration || previewLocation !== location.href) {
          logDiagnostic("fill", "blocked", "stale_preview");
          clearPreview("个人信息或页面已变化，请重新识别后再填写。");
          showNotice(validation.error || "填写预览已过期，请重新识别。", true);
          return;
        }
      }
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
          if (!cachedMatch || !cachedTarget || !cachedDescriptor) {
            stale += 1;
            continue;
          }

          const currentElements = new Map<string, FillTarget>();
          const currentDescriptors = new Map<string, FieldDescriptor>();
          const currentScan = scanPage(
            dataSource === "remote" ? EMPTY_PROFILE : state!.profile,
            currentElements,
            currentDescriptors,
            adapter,
            elementIds,
            savedMappings,
            repeatBindings,
            repeatGroupIds,
            repeatStructureNodeIds,
            dataSource === "remote" ? remoteProfileStatus?.recordOptions : undefined,
            dataSource === "remote" && overwriteExisting,
          );
          const currentMatch = currentScan.matches.find((item) => item.id === id);
          const currentTarget = currentElements.get(id);
          const currentDescriptor = currentDescriptors.get(id);
          const remoteInventoryStillPresent = currentScan.inventory.some((item) => item.id === id);
          if ((!currentMatch && cachedMatch.source !== "remote") || (cachedMatch.source === "remote" && !remoteInventoryStillPresent) || !currentTarget || !currentDescriptor) {
            stale += 1;
            continue;
          }
          const validation = validateCachedFillTarget(cachedTarget, currentTarget, cachedDescriptor, currentDescriptor, adapter, {
            allowOverwriteExistingText: dataSource === "remote" && overwriteExisting,
            expectedSnapshots: previewOriginalValues.get(id),
          });
          if (!validation.valid) {
            stale += 1;
            continue;
          }
          const before = snapshotTarget(currentTarget);
          const fillValue = cachedMatch.suggestedValue ?? cachedMatch.resolvedValue;
          if (fillTarget(currentTarget, fillValue)) {
            snapshots.push(...before);
            filled += 1;
          }
        }
      } finally {
        assistantWriteInProgress = false;
      }
      lastFill = snapshots;
      logDiagnostic("fill", filled ? "ok" : "empty", stale ? "stale_preview" : "none",
        { selected: selectedMatchIds.length, written: filled, skipped: stale });
      overwriteExisting = false;
      invalidateRepeatSnapshot();
      let refreshError = "";
      try { await refresh(); } catch (error) { refreshError = error instanceof Error ? error.message : "预览刷新失败"; }
      showNotice(
        `已填写 ${filled} 项${stale ? `，跳过 ${stale} 个扫描后已变化的过期项` : ""}。${refreshError ? `页面已经写入，但预览刷新失败：${refreshError}。` : "请逐项检查，确认无误后由你手动提交。"}`,
        stale > 0 || Boolean(refreshError),
      );
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
    if (input instanceof HTMLInputElement && input.dataset.action === "overwrite-existing") {
      const requestedOverwrite = input.checked;
      overwriteExisting = requestedOverwrite;
      clearPreview("覆盖设置已变化，正在重新生成服务端填写预览。");
      void refresh().then(
        () => {
          if (overwriteExisting === requestedOverwrite) showNotice(requestedOverwrite
            ? "已开启本次覆盖：请逐项检查标为“将覆盖已有文字”的预览。"
            : "已恢复仅填写空白字段。");
        },
        (error) => showNotice(error instanceof Error ? error.message : "无法重新识别页面。", true),
      );
      return;
    }
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
    if (input instanceof HTMLSelectElement && input.dataset.action === "map" && match && match.source !== "remote" && state) {
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

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const type = (message as { type?: string }).type;
    if (type === "OPEN_ASSISTANT") {
      manualSurface = true;
      void open();
      sendResponse({ ok: true });
    }
    if (type === "AUTOFILL_AUTH_CHANGED") {
      void refreshAuthState().then(() => {
        dataSource = "remote";
        clearPreview("登录状态已同步，正在生成填写预览。");
        void refresh().then(() => showNotice("登录成功，网申资料状态已载入。"), (error) => showNotice(error instanceof Error ? error.message : "预览失败", true));
      }, (error) => {
        clearPreview("无法载入网申资料，已停止识别与填写。");
        showNotice(error instanceof Error ? error.message : "登录同步失败。", true);
      });
    }
  });

  function updateAutomaticSurface() {
    const detection = classifyRecruitmentPage({ url: location.href, title: document.title });
    lastSurfaceLocation = `${location.href}\n${document.title}`;
    logDiagnostic("surface", detection.detected ? "ok" : "empty", detection.detected ? "none" : "not_form");
    if (panelOpen) return;
    bubble.classList.toggle("gugu-hidden", !manualSurface && !detection.detected);
  }

  const pollAutomaticSurface = () => {
    const signature = `${location.href}\n${document.title}`;
    if (signature !== lastSurfaceLocation) updateAutomaticSurface();
  };
  window.addEventListener("hashchange", updateAutomaticSurface);
  window.addEventListener("popstate", updateAutomaticSurface);
  window.setInterval(pollAutomaticSurface, 1_000);
  updateAutomaticSurface();

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
  remoteRecordOptions?: RemoteProfileStatus["recordOptions"],
  allowOverwriteExistingText = false,
): ScanPageResult {
  elements.clear();
  descriptors.clear();
  const frameScan = collectScanDocuments(document);
  const candidates = frameScan.documents.flatMap((scanDocument) => collectCandidates(scanDocument, adapter));
  const semanticInventory = collectSemanticInventory(candidates, adapter);
  const existing = semanticInventory.filter(({ element }) => (
    isEligible(element, adapter, true) && !isEligible(element, adapter, false)
  )).length;
  const matches: FieldMatch[] = [];
  const inventory: SafeFieldInventoryItem[] = [];
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
    const remoteField = toRemoteDetectedField(matchId, descriptor);
    if (remoteField) {
      elements.set(matchId, target);
      descriptors.set(matchId, descriptor);
      inventory.push({ id: matchId, descriptor });
    }
    const candidateProfileKey = decision.profileKey ?? (remoteField ? semanticProfileKey(descriptor, explicitKey) : null);
    if (candidateProfileKey) {
      recordSemanticCandidate(
        anchor,
        descriptor,
        candidateProfileKey,
        semanticIdentity,
        decision.action === "fill" || remoteField ? matchId : undefined,
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
      source: "local",
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
  for (const { element, descriptor } of semanticInventory) {
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
      registerRepeatGroup(descriptor.repeated, profile, repeatGroupMap, remoteRecordOptions);
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
    if (isIgnoredByAdapter(element, adapter) || !isEligible(element, adapter, allowOverwriteExistingText)) continue;
    const descriptor = describeField(element, adapter);
    descriptor.repeated = describeRepeatedContext(element, descriptor, adapter, repeatBindings, repeatGroupIds, repeatStructureNodeIds);
    registerRepeatGroup(descriptor.repeated, profile, repeatGroupMap, remoteRecordOptions);
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
    inventory: inventory.filter((item) => !duplicateMatchIds.has(item.id)),
    stats: { documents: frameScan.documents.length, controls: candidates.length,
      semantic: semanticInventory.length, recognized: semanticCandidatesByIdentity.size, existing },
  };
}

function manualDiagnosticCounts(items: ManualField[]): Partial<Record<DiagnosticCount, number>> {
  const counts = { manualUnknown: 0, manualMissing: 0, manualDynamic: 0, manualAttachment: 0, manualRepeat: 0, manualAmbiguous: 0 };
  for (const item of items) {
    if (item.reason === "unknown_semantics" || item.reason === "low_confidence") counts.manualUnknown += 1;
    else if (item.reason === "missing_profile_value") counts.manualMissing += 1;
    else if (item.reason === "dynamic_choice_requires_user_action") counts.manualDynamic += 1;
    else if (item.reason === "attachment_user_required") counts.manualAttachment += 1;
    else if (/^repeated_group_|^unsupported_repeated_field$/.test(item.reason)) counts.manualRepeat += 1;
    else if (/^ambiguous_|^duplicate_semantic_|^choice_group_/.test(item.reason)) counts.manualAmbiguous += 1;
  }
  return counts;
}

function registerRepeatGroup(
  context: RepeatedFieldContext | undefined,
  profile: ProfileData,
  groups: Map<string, RepeatGroupPrompt>,
  remoteRecordOptions?: RemoteProfileStatus["recordOptions"],
) {
  if (!context || groups.has(context.groupKey)) return;
  groups.set(context.groupKey, {
    groupKey: context.groupKey,
    groupLabel: context.groupLabel,
    kind: context.kind,
    selectedEntryId: context.targetEntryId,
    options: remoteRecordOptions
      ? (remoteRecordOptions[context.kind === "experience" ? "employment" : context.kind] ?? []).map((item) => ({ id: item.recordId, label: item.label }))
      : structuredEntryOptions(profile, context.kind),
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
    const identity = `${match.id}:${match.canonicalKey ?? match.key ?? "unknown"}`;
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

import panelCss from "./content.css?inline";
import { boundedDiagnostics, DIAGNOSTIC_VENDORS, formatDiagnostics, type DiagnosticInput } from "./diagnostics";
import { collectCandidates, collectScanDocuments, describeSemanticField, isInputElement, restoreElement, type ElementSnapshot } from "./dom-safety";
import { classifyRecruitmentPage } from "./page-classifier";
import type { CachedProfileSnapshot } from "./profile-snapshot";
import { createResumeDraft, editResumeDraft, type ResumeSection } from "./resume-data";
import { fillSequentially, type FieldResult, type FillProgress } from "./sequential-fill";
import { getSiteAdapter } from "./site-adapters";
import { formatStructureReport, type StructureRow } from "./structure-report";

declare global { interface Window { __guguApplicationAssistantInstalled?: boolean } }
if (!window.__guguApplicationAssistantInstalled) {
  window.__guguApplicationAssistantInstalled = true;
  installAssistant();
}
function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}
function installAssistant() {
  const host = document.createElement("div"); host.id = "gugu-application-assistant-host";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style"); style.textContent = panelCss;
  const root = document.createElement("div"); root.className = "gugu-root";
  root.innerHTML = `
    <button class="gugu-bubble gugu-hidden" aria-label="打开谷谷网申助手">谷</button>
    <aside class="gugu-panel gugu-hidden" aria-label="谷谷网申助手">
      <header><strong><span class="gugu-logo">谷</span> 网申助手</strong><div class="gugu-header-actions"><button data-action="menu" aria-label="更多操作">···</button><button data-action="close" aria-label="收起助手">⌄</button></div></header>
      <nav class="gugu-menu gugu-hidden" aria-label="更多操作">
        <button data-action="edit-profile">编辑网站资料</button><button data-action="refresh-profile">刷新资料（清除本页修改）</button>
        <button data-action="undo">撤销上次填写</button><button data-action="diagnostics">调试日志</button><button data-action="logout">退出登录</button>
      </nav>
      <div class="gugu-resume" data-role="resume"></div>
      <section class="gugu-debug gugu-hidden"><p>仅复制脱敏结构与处理结果，不含表单值。</p><pre data-role="logs"></pre><button data-action="copy-diagnostics">复制调试信息</button><button data-action="clear-diagnostics">清空</button></section>
      <footer><p role="status" data-role="status">正在读取简历…</p><button class="gugu-start" data-action="start" disabled>开始填写</button><small>填写后请检查，提交由你完成</small></footer>
    </aside>`;
  shadow.append(style, root); document.documentElement.append(host);
  const panel = root.querySelector<HTMLElement>(".gugu-panel")!;
  const bubble = root.querySelector<HTMLButtonElement>(".gugu-bubble")!;
  const resume = root.querySelector<HTMLElement>("[data-role=resume]")!;
  const status = root.querySelector<HTMLElement>("[data-role=status]")!;
  const start = root.querySelector<HTMLButtonElement>("[data-action=start]")!;
  const menu = root.querySelector<HTMLElement>(".gugu-menu")!;
  const debug = root.querySelector<HTMLElement>(".gugu-debug")!;
  const logs = root.querySelector<HTMLElement>("[data-role=logs]")!;
  const adapter = getSiteAdapter();
  const vendor = DIAGNOSTIC_VENDORS.find((item) => item === adapter.id) ?? "generic";
  let snapshot: CachedProfileSnapshot | null = null;
  let draft: ResumeSection[] = [];
  let authenticated = false, loading = false, running = false, cancelled = false, open = false;
  let authGeneration = 0;
  let lastFill: ElementSnapshot[] = [];
  let outcomes = new WeakMap<Element, FieldResult>();
  async function message<T>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
    const response = await chrome.runtime.sendMessage({ type, ...extra }) as { ok?: boolean; result?: T; error?: string; status?: number };
    if (!response.ok) {
      if (response.status === 401) authenticated = false;
      throw new Error(response.error || "操作未完成，请重试。");
    }
    return response.result as T;
  }
  const log = (input: Omit<DiagnosticInput, "vendor">) => {
    void chrome.runtime.sendMessage({ type: "RECORD_DIAGNOSTIC", diagnostic: { ...input, vendor } }).catch(() => undefined);
  };
  function setStatus(text: string, error = false) { status.textContent = text; status.classList.toggle("error", error); }
  function renderButton() {
    start.disabled = loading;
    start.textContent = loading ? "加载中…" : running ? "停止填写" : !authenticated ? "登录" : !draft.length ? "完善我的简历" : "开始填写";
    resume.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((input) => { input.disabled = running; });
  }
  function renderResume() {
    panel.classList.toggle("gugu-compact", !authenticated);
    root.querySelector<HTMLElement>("[data-action=menu]")!.hidden = !authenticated;
    if (!authenticated) { menu.classList.add("gugu-hidden"); debug.classList.add("gugu-hidden"); }
    renderButton();
    if (loading) { resume.innerHTML = '<p class="gugu-empty">正在读取我的简历…</p>'; return; }
    if (!authenticated) {
      resume.innerHTML = '';
      return;
    }
    const sections = draft;
    if (!sections.length) { resume.innerHTML = '<div class="gugu-empty"><h2>准备好你的简历</h2><p>上传简历或填写个人信息，然后回来点击开始。</p></div>'; return; }
    resume.innerHTML = '<p class="gugu-draft-hint">可直接修改，仅用于本页填写，不更改网站资料</p>' + sections.map((section, si) => `<section><h2>${escapeHtml(section.title)}</h2>${section.records.map((record, ri) =>
      `<div class="gugu-record">${record.fields.map((field, fi) => `<label class="gugu-fact ${/description|summary/.test(field.key) ? "gugu-paragraph" : ""}"><span>${escapeHtml(field.label)}</span><textarea rows="${/description|summary/.test(field.key) ? 5 : 1}" maxlength="4000" data-section="${si}" data-record="${ri}" data-field="${fi}" aria-label="${escapeHtml(section.title)} ${ri + 1} ${escapeHtml(field.label)}">${escapeHtml(field.value)}</textarea></label>`).join("")}</div>`).join("")}</section>`).join("");
  }
  async function loadProfile(force = false) {
    const generation = ++authGeneration;
    loading = true; snapshot = null; draft = []; renderResume();
    try {
      const session = await message<{ authenticated: boolean }>("GET_AUTOFILL_SESSION");
      if (generation !== authGeneration) return;
      authenticated = session.authenticated;
      if (authenticated) {
        const loaded = await message<CachedProfileSnapshot>("GET_PROFILE_SNAPSHOT", force ? { force: true } : {});
        if (generation !== authGeneration) return;
        snapshot = loaded;
        draft = createResumeDraft(loaded.profile.resumeSections ?? []);
      }
      log({ event: "auth", outcome: authenticated ? "ok" : "blocked", reason: authenticated ? "none" : "login_required" });
      setStatus(authenticated ? snapshot?.profile.resumeSections?.length ? "准备就绪" : "还没有可填写的简历" : "请先登录");
    } catch (error) {
      if (generation !== authGeneration) return;
      setStatus(error instanceof Error ? error.message : "简历暂时无法读取，请刷新重试。", true);
      log({ event: "auth", outcome: "failed", reason: "profile_unavailable" });
    } finally { if (generation === authGeneration) { loading = false; renderResume(); } }
  }
  async function openPanel() {
    open = true; panel.classList.remove("gugu-hidden"); bubble.classList.add("gugu-hidden");
    if (!snapshot && !loading) await loadProfile();
  }
  function closePanel() { open = false; panel.classList.add("gugu-hidden"); bubble.classList.remove("gugu-hidden"); }
  function showProgress(progress: FillProgress) {
    setStatus(progress.current ? `正在填写：${progress.current} · 已填 ${progress.filled} 项` : `${progress.stopped ? "已停止" : "填写结束"} · 已填 ${progress.filled} 项${progress.failed ? `，${progress.failed} 项未成功` : ""}`);
  }
  async function run() {
    if (running) { cancelled = true; setStatus("正在停止…"); return; }
    if (!authenticated) { await message("BEGIN_AUTOFILL_LOGIN"); setStatus("请在新页面登录，完成后返回这里"); return; }
    const sections = createResumeDraft(draft);
    if (!sections?.length) { await message("OPEN_PROFILE_PAGE"); return; }
    running = true; cancelled = false; lastFill = []; outcomes = new WeakMap(); menu.classList.add("gugu-hidden"); renderButton();
    try {
      const result = await fillSequentially(document, adapter, sections, {
        cancelled: () => cancelled, onProgress: showProgress, onField: (result) => outcomes.set(result.element, result),
      });
      lastFill = result.undo;
      const { visited, filled, failed, skipped } = result.progress;
      log({ event: "fill", outcome: failed ? "failed" : filled ? "ok" : "empty", reason: failed ? "write_unverified" : "none", counts: { controls: visited, retained: filled, unverified: failed, skipped } });
    } catch { setStatus("填写中断，可重试；已填内容保留在页面。", true); log({ event: "fill", outcome: "failed", reason: "other" }); }
    finally { running = false; renderButton(); }
  }
  function structureReport() {
    const scan = collectScanDocuments(document);
    const rows: StructureRow[] = []; let controls = 0;
    scan.documents.forEach((currentDoc, index) => {
      const elements = collectCandidates(currentDoc, adapter); controls += elements.length;
      for (const element of elements) {
        const descriptor = describeSemanticField(element, adapter); if (!descriptor) continue;
        const outcome = outcomes.get(element);
        rows.push({ document: index, tag: element.tagName, inputType: isInputElement(element) ? element.type : descriptor.controlType,
          parent: element.parentElement?.tagName ?? "other", parentControls: element.parentElement?.querySelectorAll("input,textarea,select").length ?? 0,
          siblingPosition: "other", labelSource: descriptor.labelSource ?? "none", semantic: "unknown", matched: outcome?.reason === "filled", outcome: outcome?.outcome ?? "none",
          resumeField: outcome?.field, resumeSection: outcome?.section, result: outcome?.reason,
        });
      }
    });
    return formatStructureReport(vendor, scan.documents.length, controls, rows);
  }
  async function readLogs() { logs.textContent = formatDiagnostics(boundedDiagnostics(await message("GET_DIAGNOSTICS"))); }
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    void (async () => {
      if (button === bubble) return openPanel();
      const action = button?.dataset.action;
      if (action === "close") return closePanel();
      if (action === "start") return run();
      if (action === "menu") { menu.classList.toggle("gugu-hidden"); return; }
      if (running) return;
      if (action === "check-auth" || action === "refresh-profile") { menu.classList.add("gugu-hidden"); return loadProfile(action === "refresh-profile"); }
      if (action === "edit-profile") return message("OPEN_PROFILE_PAGE");
      if (action === "logout") { await message("LOGOUT_AUTOFILL"); authenticated = false; snapshot = null; draft = []; lastFill = []; setStatus("已退出登录"); renderResume(); }
      if (action === "undo") { const restored = lastFill.map(restoreElement).filter(Boolean).length; setStatus(lastFill.length ? `已撤销 ${restored} 项填写` : "没有可撤销的填写"); lastFill = []; }
      if (action === "diagnostics") { menu.classList.add("gugu-hidden"); debug.classList.toggle("gugu-hidden"); await readLogs(); }
      if (action === "copy-diagnostics") { await readLogs(); await navigator.clipboard.writeText(`${logs.textContent}\n${structureReport()}`); setStatus("已复制调试信息"); }
      if (action === "clear-diagnostics") { await message("CLEAR_DIAGNOSTICS"); await readLogs(); }
    })().catch((error) => setStatus(error instanceof Error ? error.message : "操作未完成，请重试。", true));
  });
  // Editing the local resume changes only the draft; it does not scan the page or fetch data.
  resume.addEventListener("input", (event) => {
    const input = event.target as HTMLTextAreaElement;
    if (running || input.tagName !== "TEXTAREA") return;
    if (editResumeDraft(draft, Number(input.dataset.section), Number(input.dataset.record), Number(input.dataset.field), input.value)) {
      setStatus("本页修改已就绪");
    }
  });
  chrome.runtime.onMessage.addListener((message: unknown, _sender, reply) => {
    const type = (message as { type?: string }).type;
    if (type === "OPEN_ASSISTANT") { void openPanel(); reply({ ok: true }); }
    if (type === "AUTOFILL_AUTH_CHANGED") {
      cancelled = true; snapshot = null; draft = []; authenticated = false; lastFill = [];
      authGeneration++; loading = false;
      if (open) void loadProfile(); else renderResume();
    }
  });
  let lastLocation = "";
  function updateEntry() {
    if (location.href === lastLocation) return;
    lastLocation = location.href;
    const detected = classifyRecruitmentPage({ url: location.href, title: document.title }).detected;
    if (!open) bubble.classList.toggle("gugu-hidden", !detected);
  }
  // SPA navigation only. Scrolling, typing and layout mutations never start a scan.
  window.addEventListener("popstate", updateEntry); window.addEventListener("hashchange", updateEntry);
  window.setInterval(updateEntry, 1500); updateEntry();
}

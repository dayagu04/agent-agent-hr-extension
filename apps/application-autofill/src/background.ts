import { canUsePendingAuthBridge, tokenExpiresAt, type PendingAuthBridge } from "./auth-security";
import { boundedDiagnostics, sanitizeDiagnostic, type DiagnosticRecord } from "./diagnostics";
import { normalizeProfileSnapshot, type CachedProfileSnapshot } from "./profile-snapshot";
import type { RemoteDetectedField, RemoteProfileStatus, RemoteResumeSummary } from "./remote-autofill";
import { getApiKey, loadState } from "./storage";
import type { PolishRequest } from "./types";

const AUTOFILL_ORIGIN = "https://gudaya.chat";
const AUTOFILL_SESSION_KEY = "guguAutofillSession";
const PROFILE_SNAPSHOT_KEY = "guguAutofillProfileSnapshotV2";
const LEGACY_SNAPSHOT_KEY = "guguAutofillProfileSnapshot";
const PENDING_AUTH_KEY = "guguPendingAutofillAuth";
const AUTH_BRIDGE_TTL_MS = 10 * 60 * 1000;
const DIAGNOSTICS_KEY = "guguAutofillDiagnostics";
let diagnosticsWrite = Promise.resolve();
let profileSnapshotLoad: { token: string; promise: Promise<CachedProfileSnapshot> } | null = null;
// Persistent credentials must never be exposed to content scripts through storage.
const credentialStorageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let authWrites = Promise.resolve();
let authEpoch = 0;
function mutateAuth<T>(operation: () => Promise<T>): Promise<T> {
  const result = authWrites.then(operation);
  authWrites = result.then(() => undefined, () => undefined);
  return result;
}

function diagnosticSenderAllowed(sender: chrome.runtime.MessageSender): boolean {
  if (!Number.isInteger(sender.tab?.id) || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "https:" && /(^|\.)(mokahr\.com|zhiye\.com|jobs\.bytedance\.com|joinbytedance\.com)$|^(we\.zyt\.com|join\.qq\.com|campus\.tencent\.com|talent\.alibaba\.com|campus\.alibaba\.com)$/i.test(url.hostname);
  } catch { return false; }
}

function enqueueDiagnostic<T>(operation: () => Promise<T>): Promise<T> {
  const result = diagnosticsWrite.then(operation);
  diagnosticsWrite = result.then(() => undefined, () => undefined);
  return result;
}

async function readDiagnostics(): Promise<DiagnosticRecord[]> {
  const stored = await chrome.storage.session.get(DIAGNOSTICS_KEY);
  return boundedDiagnostics(stored[DIAGNOSTICS_KEY]);
}

function recordDiagnostic(input: unknown): Promise<boolean> {
  const record = sanitizeDiagnostic(input);
  if (!record) return Promise.resolve(false);
  return enqueueDiagnostic(async () => {
    const prior = await readDiagnostics();
    const previous = prior.at(-1);
    if (previous && record.at - previous.at < 2_000
      && previous.event === record.event && previous.outcome === record.outcome
      && previous.reason === record.reason && previous.vendor === record.vendor
      && JSON.stringify(previous.counts) === JSON.stringify(record.counts)) return true;
    await chrome.storage.session.set({ [DIAGNOSTICS_KEY]: boundedDiagnostics(prior, record) });
    return true;
  });
}

interface AutofillSession {
  token: string;
  displayName: string;
  userId?: number;
}

interface AutofillApiError extends Error {
  status?: number;
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

async function polishText(request: PolishRequest): Promise<string> {
  const state = await loadState();
  if (!state.ai.enabled) throw new Error("请先在个人档案中启用 AI 辅助。 ");
  const key = await getApiKey();
  if (!key) throw new Error("没有可用的 API Key，请在个人档案中配置。 ");
  const url = new URL(state.ai.baseUrl);
  const allowed = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
  if (!allowed) throw new Error("尚未授权访问该 AI 接口，请返回个人档案完成授权。 ");

  const response = await fetch(endpoint(state.ai.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: state.ai.model,
      temperature: 0.45,
      messages: [
        {
          role: "system",
          content: [
            "你是求职材料编辑。只优化用户已经提供的事实，让表达更贴合目标企业和问题。",
            "禁止虚构公司、学历、岗位、职责、奖项、日期、技术、指标和成果；不得添加原文无法支持的数字。",
            "直接返回可粘贴的正文，不要解释过程，不要使用 Markdown 标题。",
            state.ai.instructions,
          ].join("\n"),
        },
        {
          role: "user",
          content: `企业和页面语境：${request.companyContext}\n字段或问题：${request.question}\n待润色原文：\n${request.sourceText}`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`AI 接口返回 ${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const result = body.choices?.[0]?.message?.content?.trim();
  if (!result) throw new Error("AI 接口没有返回可用文本。 ");
  return result;
}

async function getAutofillSession(): Promise<AutofillSession | null> {
  await credentialStorageReady;
  // Serialize legacy migration with logout so a stale read cannot resurrect auth.
  const value = await mutateAuth(async () => {
    const local = await chrome.storage.local.get(AUTOFILL_SESSION_KEY);
    const legacy = local[AUTOFILL_SESSION_KEY] ? {} : await chrome.storage.session.get(AUTOFILL_SESSION_KEY);
    const saved = (local[AUTOFILL_SESSION_KEY] ?? legacy[AUTOFILL_SESSION_KEY]) as Partial<AutofillSession> | undefined;
    if (!saved || typeof saved.token !== "string" || tokenExpiresAt(saved.token) <= Date.now()) {
      await chrome.storage.local.remove(AUTOFILL_SESSION_KEY);
      await chrome.storage.session.remove([AUTOFILL_SESSION_KEY, PROFILE_SNAPSHOT_KEY, LEGACY_SNAPSHOT_KEY]);
      return null;
    }
    if (!local[AUTOFILL_SESSION_KEY]) await chrome.storage.local.set({ [AUTOFILL_SESSION_KEY]: saved });
    await chrome.storage.session.remove(AUTOFILL_SESSION_KEY);
    return saved;
  });
  if (!value || typeof value.token !== "string" || !value.token) return null;
  return {
    token: value.token,
    displayName: typeof value.displayName === "string" ? value.displayName : "谷谷用户",
    ...(Number.isInteger(value.userId) ? { userId: Number(value.userId) } : {}),
  };
}

async function clearAutofillSession(expectedToken?: string): Promise<void> {
  await credentialStorageReady;
  const cleared = await mutateAuth(async () => {
    if (expectedToken) {
      const local = await chrome.storage.local.get(AUTOFILL_SESSION_KEY);
      if ((local[AUTOFILL_SESSION_KEY] as AutofillSession | undefined)?.token !== expectedToken) return false;
    }
    authEpoch++;
    await chrome.storage.local.remove(AUTOFILL_SESSION_KEY);
    await chrome.storage.session.remove([AUTOFILL_SESSION_KEY, PROFILE_SNAPSHOT_KEY, LEGACY_SNAPSHOT_KEY, PENDING_AUTH_KEY]);
    return true;
  });
  if (cleared) await notifyAutofillTabs();
}

async function notifyAutofillTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) =>
    chrome.tabs.sendMessage(tab.id!, { type: "AUTOFILL_AUTH_CHANGED" }).catch(() => undefined)));
}

async function getPendingAuth(): Promise<PendingAuthBridge | null> {
  const stored = await chrome.storage.session.get(PENDING_AUTH_KEY);
  const value = stored[PENDING_AUTH_KEY] as Partial<PendingAuthBridge> | undefined;
  if (!value || !Number.isInteger(value.loginTabId) || !Number.isFinite(value.expiresAt)) return null;
  return {
    loginTabId: Number(value.loginTabId),
    expiresAt: Number(value.expiresAt),
    ...(Number.isInteger(value.requestTabId) ? { requestTabId: Number(value.requestTabId) } : {}),
  };
}

async function autofillApi(path: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${AUTOFILL_ORIGIN}${path}`, {
    ...init,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 401) {
    // A request from an older tab can finish after a new account has logged in.
    // Never let that stale 401 clear the newer browser-session credentials.
    await clearAutofillSession(token);
  }
  if (!response.ok) {
    const message = response.status === 401
      ? "登录已失效，请重新登录。"
      : response.status === 404 && path.startsWith("/api/autofill/profile/")
        ? "谷谷服务端尚未提供网申资料接口（404），需先部署配套服务端。"
        : `谷谷服务返回 ${response.status}`;
    const error = new Error(message) as AutofillApiError;
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function beginAutofillLogin(sender: chrome.runtime.MessageSender): Promise<{ loginTabId: number }> {
  const tab = await chrome.tabs.create({ url: `${AUTOFILL_ORIGIN}/login?product=application-autofill`, active: true });
  if (!Number.isInteger(tab.id)) throw new Error("无法打开谷谷登录页。 ");
  const pending: PendingAuthBridge = {
    loginTabId: Number(tab.id),
    ...(Number.isInteger(sender.tab?.id) ? { requestTabId: Number(sender.tab?.id) } : {}),
    expiresAt: Date.now() + AUTH_BRIDGE_TTL_MS,
  };
  await chrome.storage.session.set({ [PENDING_AUTH_KEY]: pending });
  return { loginTabId: pending.loginTabId };
}

async function authBridgeAllowed(sender: chrome.runtime.MessageSender): Promise<boolean> {
  const pending = await getPendingAuth();
  if (pending && pending.expiresAt <= Date.now()) await chrome.storage.session.remove(PENDING_AUTH_KEY);
  return canUsePendingAuthBridge(sender.url, sender.tab?.id, pending);
}

async function syncAutofillToken(token: unknown, sender: chrome.runtime.MessageSender): Promise<{ displayName: string }> {
  const epoch = authEpoch;
  const pending = await getPendingAuth();
  if (!canUsePendingAuthBridge(sender.url, sender.tab?.id, pending)) throw new Error("登录同步请求已失效，请从网申页面重新发起。 ");
  if (typeof token !== "string" || token.length < 20 || token.length > 8_192 || /[\r\n]/.test(token)) {
    throw new Error("登录凭据格式无效。 ");
  }
  if (tokenExpiresAt(token) <= Date.now()) throw new Error("登录已过期，请在网站重新登录。");
  const raw = await autofillApi("/api/autofill/profile/snapshot", token);
  const snapshot = normalizeProfileSnapshot(raw);
  const session: AutofillSession = {
    token,
    displayName: snapshot.account.displayName,
    userId: snapshot.account.userId,
  };
  // Cache the wire format, not the flattened projection: reads validate and
  // project it exactly once, including after a service-worker restart.
  await credentialStorageReady;
  await mutateAuth(async () => {
    const currentPending = await getPendingAuth();
    if (epoch !== authEpoch || !canUsePendingAuthBridge(sender.url, sender.tab?.id, currentPending)) {
      throw new Error("登录状态已变化，请重新发起登录。");
    }
    await chrome.storage.local.set({ [AUTOFILL_SESSION_KEY]: session });
    await chrome.storage.session.remove([AUTOFILL_SESSION_KEY, LEGACY_SNAPSHOT_KEY, PENDING_AUTH_KEY]);
    await chrome.storage.session.set({ [PROFILE_SNAPSHOT_KEY]: raw });
  });
  await notifyAutofillTabs();
  return { displayName: session.displayName };
}

async function requireAutofillSession(): Promise<AutofillSession> {
  const session = await getAutofillSession();
  if (!session) throw new Error("请先登录谷谷账号。 ");
  return session;
}

async function getProfileSnapshot(force = false): Promise<CachedProfileSnapshot> {
  const session = await requireAutofillSession();
  if (!force) {
    const stored = await chrome.storage.session.get(PROFILE_SNAPSHOT_KEY);
    try {
      const cached = normalizeProfileSnapshot(stored[PROFILE_SNAPSHOT_KEY]);
      const active = await getAutofillSession();
      if (active?.token === session.token && (!session.userId || cached.account.userId === session.userId)) return cached;
    } catch {
      await chrome.storage.session.remove(PROFILE_SNAPSHOT_KEY);
    }
  }
  if (profileSnapshotLoad?.token === session.token) return profileSnapshotLoad.promise;
  const promise = (async () => {
    const raw = await autofillApi("/api/autofill/profile/snapshot", session.token);
    const snapshot = normalizeProfileSnapshot(raw);
    const active = await getAutofillSession();
    if (!active || active.token !== session.token) throw new Error("登录状态已变化，请重新打开助手。");
    if (session.userId && snapshot.account.userId !== session.userId) {
      await clearAutofillSession();
      throw new Error("网申资料账号与登录账号不一致，请重新登录。");
    }
    await mutateAuth(async () => {
      const local = await chrome.storage.local.get(AUTOFILL_SESSION_KEY);
      if ((local[AUTOFILL_SESSION_KEY] as AutofillSession | undefined)?.token !== session.token) {
        throw new Error("登录状态已变化，请重新打开助手。");
      }
      await chrome.storage.session.remove(LEGACY_SNAPSHOT_KEY);
      await chrome.storage.session.set({ [PROFILE_SNAPSHOT_KEY]: raw });
    });
    return snapshot;
  })();
  profileSnapshotLoad = { token: session.token, promise };
  try {
    return await promise;
  } finally {
    if (profileSnapshotLoad?.promise === promise) profileSnapshotLoad = null;
  }
}

async function listRemoteResumes(): Promise<RemoteResumeSummary[]> {
  const session = await requireAutofillSession();
  const body = await autofillApi("/api/autofill/resumes", session.token);
  if (!Array.isArray(body)) throw new Error("云端简历列表格式无效。 ");
  return body.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (!Number.isInteger(row.resumeId) || Number(row.resumeId) < 1 || typeof row.name !== "string") return [];
    return [{ resumeId: Number(row.resumeId), name: row.name.slice(0, 200) }];
  });
}

const ALLOWED_REMOTE_CONTROLS = new Set([
  "text", "textarea", "email", "tel", "url", "date", "month", "number", "select", "multi_select", "radio", "checkbox",
]);

function shortText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function sanitizeRemoteFields(value: unknown): RemoteDetectedField[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 150) throw new Error("页面字段数量无效。 ");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("页面字段格式无效。 ");
    const row = item as Record<string, unknown>;
    const fieldId = shortText(row.fieldId, 128);
    const controlType = shortText(row.controlType, 30);
    if (!fieldId || seen.has(fieldId) || !ALLOWED_REMOTE_CONTROLS.has(controlType)) throw new Error("页面字段标识无效。 ");
    seen.add(fieldId);
    const options = Array.isArray(row.options) ? row.options : [];
    if (options.length > 100) throw new Error("页面选项数量无效。 ");
    const kind = row.recordKind;
    const recordId = row.recordId;
    const recordField = row.recordField;
    if (kind !== undefined && (typeof kind !== "string" || !/^[A-Za-z]{1,32}$/.test(kind))) throw new Error("重复经历类型无效。");
    if (recordId !== undefined && (typeof recordId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(recordId))) throw new Error("重复经历记录无效。");
    if (recordId !== undefined && kind === undefined) throw new Error("重复经历记录缺少类型。");
    if (recordField !== undefined && (typeof recordField !== "string" || !/^[A-Za-z]{1,32}$/.test(recordField) || kind === undefined)) throw new Error("重复经历字段无效。");
    return {
      fieldId,
      label: shortText(row.label, 300),
      ariaLabel: shortText(row.ariaLabel, 300),
      placeholder: shortText(row.placeholder, 300),
      name: shortText(row.name, 300),
      controlType: controlType as RemoteDetectedField["controlType"],
      required: Boolean(row.required),
      hidden: Boolean(row.hidden),
      disabled: Boolean(row.disabled),
      readOnly: Boolean(row.readOnly),
      hasValue: Boolean(row.hasValue),
      options: options.map((option) => {
        const candidate = option && typeof option === "object" ? option as Record<string, unknown> : {};
        return { value: shortText(candidate.value, 500), label: shortText(candidate.label, 500), disabled: Boolean(candidate.disabled) };
      }),
      ...(kind ? { recordKind: kind } : {}),
      ...(recordId ? { recordId } : {}),
      ...(recordField ? { recordField } : {}),
    };
  });
}

async function getProfileStatus(): Promise<RemoteProfileStatus> {
  const session = await requireAutofillSession();
  const body = await autofillApi("/api/autofill/profile/status", session.token);
  if (!body || typeof body !== "object") throw new Error("网申资料状态格式无效。");
  const value = body as Record<string, unknown>;
  if (!Number.isInteger(value.publishedRevision) || Number(value.publishedRevision) < 0
    || !Number.isInteger(value.draftRevision) || Number(value.draftRevision) < 0
    || !["active", "empty"].includes(String(value.publishedStatus))) {
    throw new Error("网申资料状态格式无效。");
  }
  const rawOptions = value.recordOptions;
  if (!rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions)) throw new Error("经历摘要格式无效。");
  const recordOptions: RemoteProfileStatus["recordOptions"] = {};
  for (const [kind, records] of Object.entries(rawOptions)) {
    if (!/^[A-Za-z]{1,32}$/.test(kind) || !Array.isArray(records) || records.length > 100) throw new Error("经历摘要格式无效。");
    recordOptions[kind] = records.map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      if (typeof row.recordId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(row.recordId) || typeof row.label !== "string") {
        throw new Error("经历摘要格式无效。");
      }
      return { recordId: row.recordId, label: row.label.slice(0, 120) };
    });
  }
  return {
    draftRevision: Number(value.draftRevision),
    publishedRevision: Number(value.publishedRevision),
    publishedStatus: value.publishedStatus as RemoteProfileStatus["publishedStatus"],
    hasPendingImport: value.hasPendingImport === true,
    hasUnpublishedDraft: value.hasUnpublishedDraft === true,
    recordOptions,
  };
}

async function openProfilePage(sender: chrome.runtime.MessageSender): Promise<boolean> {
  // 先经过网站统一登录页：已有网站会话会直接回跳资料页，并让桥接刷新扩展身份；
  // 未登录网站则由用户扫码，避免网站账号与扩展账号不一致。
  await beginAutofillLogin(sender);
  return true;
}

async function createProfilePlan(revision: unknown, vendor: unknown, fields: unknown, overwriteExisting: unknown): Promise<unknown> {
  if (!Number.isInteger(revision) || Number(revision) < 1) throw new Error("请先在网站写入或保存网申资料。");
  if (overwriteExisting !== undefined && typeof overwriteExisting !== "boolean") throw new Error("覆盖设置无效。");
  const safeVendor = typeof vendor === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(vendor) ? vendor : "generic";
  const safeFields = sanitizeRemoteFields(fields);
  const session = await requireAutofillSession();
  return autofillApi("/api/autofill/profile/plan", session.token, {
    method: "POST", body: JSON.stringify({
      publishedRevision: Number(revision), vendor: safeVendor, fields: safeFields,
      ...(overwriteExisting === true ? { overwriteExisting: true } : {}),
    }),
  });
}

async function validateProfileRevision(revision: unknown): Promise<boolean> {
  if (!Number.isInteger(revision) || Number(revision) < 1) throw new Error("填写预览版本无效。");
  const session = await requireAutofillSession();
  const result = await autofillApi("/api/autofill/profile/validate", session.token, {
    method: "POST", body: JSON.stringify({ publishedRevision: Number(revision) }),
  }) as { valid?: boolean; publishedRevision?: number };
  return result.valid === true && result.publishedRevision === revision;
}

async function createRemotePlan(resumeId: unknown, vendor: unknown, fields: unknown): Promise<unknown> {
  if (!Number.isInteger(resumeId) || Number(resumeId) < 1) throw new Error("请选择有效的云端简历。 ");
  const safeVendor = typeof vendor === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(vendor) ? vendor : "generic";
  const safeFields = sanitizeRemoteFields(fields);
  const session = await requireAutofillSession();
  return autofillApi("/api/autofill/plan", session.token, {
    method: "POST",
    body: JSON.stringify({ resumeId: Number(resumeId), vendor: safeVendor, fields: safeFields }),
  });
}

function reply<T>(promise: Promise<T>, sendResponse: (response: unknown) => void): true {
  promise.then(
    (result) => sendResponse({ ok: true, result }),
    (error: unknown) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "操作失败。",
      status: typeof (error as AutofillApiError)?.status === "number" ? (error as AutofillApiError).status : undefined,
    }),
  );
  return true;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const payload = message as { type?: string; request?: PolishRequest; token?: unknown; resumeId?: unknown; revision?: unknown; vendor?: unknown; fields?: unknown; overwriteExisting?: unknown; diagnostic?: unknown; force?: unknown };
  if (["RECORD_DIAGNOSTIC", "GET_DIAGNOSTICS", "CLEAR_DIAGNOSTICS"].includes(payload.type ?? "")) {
    if (!diagnosticSenderAllowed(sender)) {
      sendResponse({ ok: false });
      return false;
    }
    if (payload.type === "RECORD_DIAGNOSTIC") return reply(recordDiagnostic(payload.diagnostic), sendResponse);
    if (payload.type === "GET_DIAGNOSTICS") return reply(enqueueDiagnostic(readDiagnostics), sendResponse);
    return reply(enqueueDiagnostic(async () => { await chrome.storage.session.remove(DIAGNOSTICS_KEY); return true; }), sendResponse);
  }
  if (payload.type === "GET_ASSISTANT_STATE") {
    loadState().then((state) => {
      const { apiKey: _secret, ...safeState } = state;
      sendResponse({ ok: true, state: safeState });
    }, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (payload.type === "POLISH_TEXT" && payload.request) {
    polishText(payload.request).then((text) => sendResponse({ ok: true, text }), (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (payload.type === "GET_AUTOFILL_SESSION") {
    return reply(getAutofillSession().then((session) => ({ authenticated: Boolean(session), displayName: session?.displayName ?? "" })), sendResponse);
  }
  if (payload.type === "BEGIN_AUTOFILL_LOGIN") return reply(beginAutofillLogin(sender), sendResponse);
  if (payload.type === "AUTH_BRIDGE_STATUS") return reply(authBridgeAllowed(sender), sendResponse);
  if (payload.type === "SYNC_AUTOFILL_TOKEN") return reply(syncAutofillToken(payload.token, sender), sendResponse);
  if (payload.type === "LOGOUT_AUTOFILL") return reply(clearAutofillSession(), sendResponse);
  if (payload.type === "GET_REMOTE_RESUMES") return reply(listRemoteResumes(), sendResponse);
  if (payload.type === "CREATE_REMOTE_PLAN") return reply(createRemotePlan(payload.resumeId, payload.vendor, payload.fields), sendResponse);
  if (payload.type === "GET_PROFILE_STATUS") return reply(getProfileStatus(), sendResponse);
  if (payload.type === "GET_PROFILE_SNAPSHOT") return reply(getProfileSnapshot(payload.force === true), sendResponse);
  if (payload.type === "CREATE_PROFILE_PLAN") return reply(createProfilePlan(payload.revision, payload.vendor, payload.fields, payload.overwriteExisting), sendResponse);
  if (payload.type === "VALIDATE_PROFILE_REVISION") return reply(validateProfileRevision(payload.revision), sendResponse);
  if (payload.type === "OPEN_PROFILE_PAGE") return reply(openProfilePage(sender), sendResponse);
  return false;
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("the real background caches intact snapshots across reads and worker restarts with one request", async () => {
  const content = readFileSync(new URL("../src/content.ts", import.meta.url), "utf8");
  assert.equal(content.includes("CREATE_PROFILE_PLAN"), false);
  assert.equal(content.includes("VALIDATE_PROFILE_REVISION"), false);
  assert.equal(content.includes("GET_PROFILE_STATUS"), false);
  assert.equal(content.includes("GET_PROFILE_SNAPSHOT"), true);
  assert.match(content, /data-action="refresh-profile"/);

  assert.equal(/(?:window|document)\.addEventListener\(["'](?:scroll|input|change)["']/.test(content), false);
  const source = readFileSync(new URL("../dist/background.js", import.meta.url), "utf8");
  const sessionKey = "guguAutofillSession";
  const token = (exp = Math.floor(Date.now() / 1000) + 3600) => `test.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
  const store: Record<string, unknown> = { [sessionKey]: { token: token(), userId: 7 } };
  const persistent: Record<string, unknown> = {};
  let accessLevel = "", responseStatus = 200;
  let requests = 0;
  let gate: Promise<void> | undefined;
  const body = { schemaVersion: 1, account: { userId: 7, displayName: "测试" }, draftRevision: 1, publishedRevision: 1, publishedStatus: "active",
    profile: { basic: { legal_name_zh: "示例姓名", contact_email: "person@example.invalid" }, projects: [{ recordId: "project01", name: "示例项目", responsibilities: "示例内容" }] } };
  type Response = { ok: boolean; result?: { authenticated?: boolean; profile: { fullName: string; resumeSections: Array<{ key: string }> } }; error?: string };
  const storage = (data: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); },
    remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const boot = () => {
    let listener: (message: unknown, sender: unknown, reply: (value: Response) => void) => void;
    runInNewContext(source, {
      URL, console, atob,
      fetch: async () => { requests++; await gate; return { ok: responseStatus === 200, status: responseStatus, json: async () => structuredClone(body) }; },
      chrome: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } },
        tabs: { query: async () => [], sendMessage: async () => undefined },
        storage: { session: storage(store), local: { ...storage(persistent), setAccessLevel: async ({ accessLevel: level }: { accessLevel: string }) => { accessLevel = level; } } } },
    });
    return (message: unknown, sender: unknown = {}) => new Promise<Response>((resolve) => listener(message, sender, resolve));
  };
  let send = boot();
  const [first, concurrent] = await Promise.all([send({ type: "GET_PROFILE_SNAPSHOT" }), send({ type: "GET_PROFILE_SNAPSHOT" })]);
  assert.equal(requests, 1);
  assert.equal(accessLevel, "TRUSTED_CONTEXTS");
  assert.ok(persistent[sessionKey], "legacy session migrated to persistent credentials");
  assert.equal(store[sessionKey], undefined);
  assert.equal(first.result?.profile.fullName, "示例姓名");
  assert.equal(concurrent.result?.profile.fullName, "示例姓名");
  send = boot(); // Chrome may stop/restart the worker, not session storage.
  const cached = await send({ type: "GET_PROFILE_SNAPSHOT" });
  assert.equal(cached.result?.profile.fullName, "示例姓名");
  assert.ok(cached.result?.profile.resumeSections.some((section) => section.key === "projects"));
  assert.equal(requests, 1);
  await send({ type: "GET_PROFILE_SNAPSHOT", force: true });
  assert.equal(requests, 2);
  // Browser/extension restart clears session data but keeps valid credentials.
  for (const key of Object.keys(store)) delete store[key];
  send = boot();
  assert.equal((await send({ type: "GET_AUTOFILL_SESSION" })).result?.authenticated, true);
  assert.equal((await send({ type: "GET_PROFILE_SNAPSHOT" })).result?.profile.fullName, "示例姓名");
  assert.equal(requests, 3);
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = send({ type: "GET_PROFILE_SNAPSHOT", force: true });
  while (requests < 4) await new Promise((resolve) => setImmediate(resolve));
  await send({ type: "LOGOUT_AUTOFILL" });
  release();
  assert.equal((await pending).ok, false);
  assert.equal(Object.keys(store).length, 0);
  assert.equal(Object.keys(persistent).length, 0);
  assert.equal((await send({ type: "GET_PROFILE_SNAPSHOT" })).ok, false);
  assert.equal(requests, 4);
  gate = undefined;
  persistent[sessionKey] = { token: token(1), userId: 7 };
  assert.equal((await boot()({ type: "GET_PROFILE_SNAPSHOT" })).ok, false);
  assert.equal(Object.keys(persistent).length, 0);
  assert.equal(requests, 4, "expired credentials are rejected without a request");
  persistent[sessionKey] = { token: token(), userId: 7 };
  responseStatus = 401;
  assert.equal((await boot()({ type: "GET_PROFILE_SNAPSHOT" })).ok, false);
  assert.equal(Object.keys(persistent).length, 0);
  assert.equal(Object.keys(store).length, 0);
  // A login validation response arriving after logout cannot recreate credentials.
  responseStatus = 200;
  store.guguPendingAutofillAuth = { loginTabId: 42, expiresAt: Date.now() + 60_000 };
  gate = new Promise<void>((resolve) => { release = resolve; });
  const countBeforeLogin = requests;
  send = boot();
  const login = send({ type: "SYNC_AUTOFILL_TOKEN", token: token() }, { tab: { id: 42 }, url: "https://gudaya.chat/application-profile" });
  while (requests === countBeforeLogin) await new Promise((resolve) => setImmediate(resolve));
  await send({ type: "LOGOUT_AUTOFILL" });
  release();
  assert.equal((await login).ok, false);
  assert.equal(Object.keys(persistent).length, 0);
  assert.equal(Object.keys(store).length, 0);
});

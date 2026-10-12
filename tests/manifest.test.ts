import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const manifestPath = fileURLToPath(new URL("../public/manifest.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  version: string;
  host_permissions?: string[];
  content_scripts?: Array<{ matches: string[]; js: string[] }>;
};
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

test("manifest auto-surfaces only on the supported ATS allowlist", () => {
  assert.equal(manifest.version, packageVersion);
  const ats = manifest.content_scripts?.find((entry) => entry.js.includes("content.js"));
  assert.ok(ats);
  assert.ok(ats.matches.includes("https://*.mokahr.com/*"));
  assert.ok(ats.matches.includes("https://we.zyt.com/*"));
  assert.ok(ats.matches.includes("https://joinbytedance.com/*"));
  assert.equal(ats.matches.some((pattern) => pattern.includes("<all_urls>")), false);
});

test("first-party auth bridge and persistent host permission stay narrow", () => {
  assert.deepEqual(manifest.host_permissions?.sort(), ["https://gudaya.chat/*", "https://www.gudaya.chat/*"].sort());
  const auth = manifest.content_scripts?.find((entry) => entry.js.includes("auth-sync.js"));
  assert.deepEqual(auth?.matches.sort(), ["https://gudaya.chat/*", "https://www.gudaya.chat/*"].sort());
  assert.equal(manifest.host_permissions?.some((pattern) => pattern.includes("<all_urls>")), false);
});

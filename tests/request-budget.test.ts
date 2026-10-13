import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the page fill loop consumes a session snapshot and has no per-pass profile requests", () => {
  const content = readFileSync(new URL("../src/content.ts", import.meta.url), "utf8");
  assert.equal(content.includes("CREATE_PROFILE_PLAN"), false);
  assert.equal(content.includes("VALIDATE_PROFILE_REVISION"), false);
  assert.equal(content.includes("GET_PROFILE_STATUS"), false);
  assert.equal(content.includes("GET_PROFILE_SNAPSHOT"), true);
  assert.match(content, /data-action="refresh-profile"/);

  const background = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
  assert.match(background, /chrome\.storage\.session\.get\(PROFILE_SNAPSHOT_KEY\)/);
  assert.match(background, /\/api\/autofill\/profile\/snapshot/);
  assert.match(background, /profileSnapshotLoad\?\.token === session\.token/);
});

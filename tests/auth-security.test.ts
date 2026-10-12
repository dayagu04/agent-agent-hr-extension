import assert from "node:assert/strict";
import test from "node:test";

import { canUsePendingAuthBridge, isTrustedAutofillFirstPartyUrl } from "../src/auth-security.ts";

test("auth bridge accepts only exact HTTPS first-party origins", () => {
  assert.equal(isTrustedAutofillFirstPartyUrl("https://gudaya.chat/login"), true);
  assert.equal(isTrustedAutofillFirstPartyUrl("https://www.gudaya.chat/social"), true);
  assert.equal(isTrustedAutofillFirstPartyUrl("http://gudaya.chat/login"), false);
  assert.equal(isTrustedAutofillFirstPartyUrl("https://gudaya.chat.evil.example/login"), false);
  assert.equal(isTrustedAutofillFirstPartyUrl("not a url"), false);
});

test("auth bridge requires the pending login tab and an unexpired request", () => {
  const pending = { loginTabId: 42, requestTabId: 9, expiresAt: 5_000 };
  assert.equal(canUsePendingAuthBridge("https://gudaya.chat/social", 42, pending, 4_999), true);
  assert.equal(canUsePendingAuthBridge("https://gudaya.chat/social", 41, pending, 4_999), false);
  assert.equal(canUsePendingAuthBridge("https://gudaya.chat/social", 42, pending, 5_000), false);
  assert.equal(canUsePendingAuthBridge("https://evil.example/", 42, pending, 4_999), false);
  assert.equal(canUsePendingAuthBridge("https://gudaya.chat/social", 42, null, 4_999), false);
});

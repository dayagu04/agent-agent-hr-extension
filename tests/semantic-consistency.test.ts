import assert from "node:assert/strict";
import test from "node:test";

import { canonicalProfileKey, hasSemanticConflict, signalProfileKey } from "../src/semantic-consistency.ts";

test("known server keys and independent DOM hints expose a phone/email mix-up", () => {
  assert.equal(canonicalProfileKey("personal.full_name"), "fullName");
  assert.equal(canonicalProfileKey("contact_email"), "email");
  assert.equal(canonicalProfileKey("unknown_custom_field"), null);
  assert.equal(signalProfileKey("邮箱"), "email");
  assert.equal(hasSemanticConflict({ controlType: "text", label: "邮箱", name: "phone" }, "email"), true);
  assert.equal(hasSemanticConflict({ controlType: "text", label: "邮箱" }, "phone"), true);
  assert.equal(hasSemanticConflict({ controlType: "text", label: "邮箱", name: "email" }, "contact_email"), false);
  assert.equal(hasSemanticConflict({ controlType: "text", label: "邮箱" }, "unknown_custom_field"), false);
});

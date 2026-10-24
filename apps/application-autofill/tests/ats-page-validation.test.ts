import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { matchDescriptor, type FieldDecision, type FieldDescriptor } from "../src/field-matcher.ts";
import { EMPTY_PROFILE, type ProfileData } from "../src/types.ts";

interface AtsPageFixture {
  platform: "moka" | "beisen" | "bytedance";
  publicEntryEvidence: {
    jobList: boolean;
    jobDetail: boolean;
    applyOutcome: "login_wall";
    applicationFormVisible: boolean;
  };
  profile: Partial<ProfileData>;
  field: FieldDescriptor;
  expected: Pick<FieldDecision, "action" | "reason">;
}

const fixturePath = fileURLToPath(new URL("./fixtures/ats-page-validation.json", import.meta.url));
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as AtsPageFixture[];

test("public ATS evidence stops at login and never claims form validation", () => {
  assert.deepEqual(fixtures.map((fixture) => fixture.platform).sort(), ["beisen", "bytedance", "moka"]);
  for (const fixture of fixtures) {
    assert.equal(fixture.publicEntryEvidence.jobList, true, fixture.platform);
    assert.equal(fixture.publicEntryEvidence.jobDetail, true, fixture.platform);
    assert.equal(fixture.publicEntryEvidence.applyOutcome, "login_wall", fixture.platform);
    assert.equal(fixture.publicEntryEvidence.applicationFormVisible, false, fixture.platform);
  }
});

test("sanitized ATS replay controls fail closed", () => {
  for (const fixture of fixtures) {
    const decision = matchDescriptor({ ...fixture.field }, { ...EMPTY_PROFILE, ...fixture.profile } as ProfileData);
    assert.equal(decision.action, fixture.expected.action, fixture.platform);
    assert.equal(decision.reason, fixture.expected.reason, fixture.platform);
  }
});

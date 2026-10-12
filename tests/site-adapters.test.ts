import assert from "node:assert/strict";
import test from "node:test";

import { getSiteAdapter } from "../src/site-adapters.ts";

test("public ATS hosts select explicit adapters", () => {
  assert.equal(getSiteAdapter("https://app.mokahr.com/social-recruitment/example/1").id, "moka");
  assert.equal(getSiteAdapter("https://example.zhiye.com/social/jobs").id, "beisen");
  assert.equal(getSiteAdapter("https://we.zyt.com/form?jobAdId=1").id, "beisen");
  assert.equal(getSiteAdapter("https://jobs.bytedance.com/experienced/resume/1/apply").id, "bytedance");
  assert.equal(getSiteAdapter("https://joinbytedance.com/search/7245221408137414973").id, "bytedance");
});

test("ATS adapters declare repeat and dynamic-choice boundaries", () => {
  for (const url of [
    "https://app.mokahr.com/apply/example/1",
    "https://example.zhiye.com/social/jobs",
    "https://jobs.bytedance.com/experienced/position",
  ]) {
    const adapter = getSiteAdapter(url);
    assert.ok(adapter.repeatedGroupSelectors.length > 0, `${adapter.id} repeat selectors`);
    assert.ok(adapter.dynamicChoiceSelectors.some((selector) => selector.includes("combobox")), `${adapter.id} combobox selector`);
  }
});

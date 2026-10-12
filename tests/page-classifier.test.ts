import assert from "node:assert/strict";
import test from "node:test";

import { classifyRecruitmentPage, supportedAtsAdapter } from "../src/page-classifier.ts";

test("Moka SPA apply route is detected without reading page fields", () => {
  const result = classifyRecruitmentPage({
    url: "https://app.mokahr.com/campus_apply/3songshu/457#/job/07f46916-1dfc-4f18-a25f-5b1242dafe78/apply",
    title: "",
  });
  assert.deepEqual(result, {
    detected: true,
    adapterId: "moka",
    kind: "application_form",
    reason: "application_route",
  });
});

test("known Chinese recruitment detail routes surface the assistant", () => {
  assert.equal(classifyRecruitmentPage({ url: "https://joinbytedance.com/search/7245221408137414973" }).kind, "job_detail");
  assert.equal(classifyRecruitmentPage({ url: "https://example.zhiye.com/social/jobs/123" }).adapterId, "beisen");
  assert.equal(classifyRecruitmentPage({ url: "https://join.qq.com/post.html?id=123", title: "腾讯招聘职位" }).detected, true);
});

test("Beisen zyt application form auto-surfaces only for a job application", () => {
  assert.deepEqual(classifyRecruitmentPage({
    url: "https://we.zyt.com/form?fromPage=job&jobAdId=970fd84f-f0e3-4f16-a076-0c37fc129f02&userId=84574997",
    title: "深圳市卓驭科技有限公司",
  }), {
    detected: true,
    adapterId: "beisen",
    kind: "application_form",
    reason: "application_route",
  });
  assert.equal(classifyRecruitmentPage({ url: "https://we.zyt.com/form?fromPage=job" }).detected, false);
  assert.equal(supportedAtsAdapter("https://we.zyt.com.evil.example/form?jobAdId=1"), null);
});

test("known host unrelated route stays hidden until a manual toolbar gesture", () => {
  assert.deepEqual(classifyRecruitmentPage({ url: "https://app.mokahr.com/account/settings", title: "账户设置" }), {
    detected: false,
    adapterId: "moka",
    kind: null,
    reason: "unknown_route",
  });
});

test("lookalike and unsupported hosts are rejected", () => {
  assert.equal(supportedAtsAdapter("https://mokahr.com.evil.example/job/1"), null);
  assert.equal(supportedAtsAdapter("https://joinbytedance.com.evil.example/search/1"), null);
  assert.equal(classifyRecruitmentPage({ url: "javascript:alert(1)", title: "招聘" }).detected, false);
});

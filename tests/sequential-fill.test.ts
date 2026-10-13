import assert from "node:assert/strict";
import test from "node:test";
import { buildResumeSections, createResumeDraft, editResumeDraft, sectionKey } from "../src/resume-data.ts";
import { RecordOrder, resolveResumeValue, sameChoice, walkControls } from "../src/sequential-fill.ts";

test("start traverses controls once, resolves cached records at each visit and stops on request", async () => {
  const sections = buildResumeSections({ basic: { legal_name_zh: "示例姓名", contact_email: "person@example.invalid" },
    educations: [{ recordId: "education1", school_name: "示例大学", college: "示例学院", major: "示例专业", education_level: "本科" }],
    employments: [{ recordId: "intern0001", employment_kind: "实习", employer_name: "实习单位" }, { recordId: "work00001", employer_name: "工作单位" }],
    projects: [{ recordId: "project01", name: "项目一", responsibilities: "开发", results: "成果" }, { recordId: "project02", name: "项目二", responsibilities: "维护" }],
  });
  const value = (label: string, section = "basic", index = 0) => resolveResumeValue(sections, { label, controlType: "text" }, section, index)?.value;
  assert.equal(value("姓名"), "示例姓名");
  const local = createResumeDraft(sections);
  assert.equal(editResumeDraft(local, 0, 0, 0, "本页姓名"), true);
  assert.equal(resolveResumeValue(local, { label: "姓名", controlType: "text" })?.value, "本页姓名");
  assert.equal(value("姓名"), "示例姓名", "server cache is not changed");
  assert.equal(editResumeDraft(local, 0, 0, 0, ""), true);
  assert.equal(resolveResumeValue(local, { label: "姓名", controlType: "text" })?.value, "", "cleared draft does not fall back to server");
  assert.equal(editResumeDraft(local, -1, 0, 0, "bad"), false);
  assert.equal(editResumeDraft(local, 0, 0, 0, "x".repeat(4001)), false);
  assert.equal(value("学院名称", "educations"), "示例学院");
  assert.equal(value("最高学历"), "本科");
  assert.equal(value("最高学历院校"), "示例大学");
  assert.equal(value("公司名称", "internships"), "实习单位");
  assert.equal(value("公司名称", "work"), "工作单位");
  assert.equal(value("项目描述", "projects"), "开发\n成果");
  assert.equal(value("描述", "projects"), "开发\n成果");
  assert.equal(value("描述", "basic"), undefined);
  assert.equal(value("工作类型", "internships"), "实习");
  assert.equal(sectionKey("工作/实习经历"), "experience");
  assert.equal(sectionKey("工作经验"), "work");
  assert.equal(sectionKey("联系信息"), "basic");
  assert.equal(value("项目名称", "projects", 1), "项目二");
  assert.equal(value("项目名称", "projects", 2), "");
  for (const descriptor of [
    { label: "邮箱", name: "phone", controlType: "text" as const },
    { label: "手机号", controlType: "email" as const },
    { label: "推荐人姓名", controlType: "text" as const },
    { label: "我同意协议", name: "name", controlType: "checkbox" as const },
  ]) assert.equal(resolveResumeValue(sections, descriptor), null);
  assert.equal(sameChoice("本科", "学士"), true);
  assert.equal(sameChoice("女", "男女不限"), false);
  const order = new RecordOrder();
  assert.deepEqual([order.index("projects", "name", "a"), order.index("projects", "description", "b"), order.index("projects", "name", "c"), order.index("projects", "name", "a"), order.index("projects", "description", "d")], [0, 0, 1, 0, 1]);

  const controls = ["first", "second"];
  const visited: string[] = [];
  let discoveries = 0, mutated = false, stopped = false;
  await walkControls({
    discover: () => { discoveries++; return [...controls]; }, identity: (item) => item,
    cancelled: () => stopped, changed: () => { const value = mutated; mutated = false; return value; },
    visit: async (item) => { visited.push(item); if (item === "second") { controls.push("lazy", "never"); mutated = true; } if (item === "lazy") stopped = true; },
  });
  assert.deepEqual(visited, ["first", "second", "lazy"]);
  assert.equal(discoveries, 2);
});

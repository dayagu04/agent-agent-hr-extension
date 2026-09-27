import "./app.css";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as mammoth from "mammoth/mammoth.browser";
import { clearState, getApiKey, loadState, saveState } from "./storage";
import { DEFAULT_STATE, PROFILE_FIELD_KEYS, type AwardEntry, type EducationEntry, type ExperienceEntry, type ProfileData, type ProjectEntry, type StoredState } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const form = document.querySelector<HTMLFormElement>("#profileForm")!;
const saveBadge = document.querySelector<HTMLElement>("#saveState")!;
const fileInput = document.querySelector<HTMLInputElement>("#resumeFile")!;
const importState = document.querySelector<HTMLElement>("#importState")!;
const rawText = document.querySelector<HTMLTextAreaElement>("#resumeRawText")!;
const aiEnabled = document.querySelector<HTMLInputElement>("#aiEnabled")!;
const aiSettings = document.querySelector<HTMLElement>("#aiSettings")!;
const aiBaseUrl = document.querySelector<HTMLInputElement>("#aiBaseUrl")!;
const aiModel = document.querySelector<HTMLInputElement>("#aiModel")!;
const aiKey = document.querySelector<HTMLInputElement>("#aiKey")!;
const rememberKey = document.querySelector<HTMLInputElement>("#rememberKey")!;
const aiInstructions = document.querySelector<HTMLTextAreaElement>("#aiInstructions")!;

type EntryGroup = "education" | "experience" | "project" | "award";
type EntryRecord = EducationEntry | ExperienceEntry | ProjectEntry | AwardEntry;
const ENTRY_CONFIG: Record<EntryGroup, { container: string; fields: Array<{ key: string; label: string; wide?: boolean; multiline?: boolean }> }> = {
  education: { container: "educationEntries", fields: [
    { key: "school", label: "学校" }, { key: "major", label: "专业" }, { key: "degree", label: "学历" },
    { key: "startDate", label: "入学时间" }, { key: "endDate", label: "毕业时间" }, { key: "gpa", label: "GPA" }, { key: "description", label: "补充说明", wide: true, multiline: true },
  ] },
  experience: { container: "experienceEntries", fields: [
    { key: "organization", label: "单位" }, { key: "role", label: "岗位" }, { key: "startDate", label: "开始时间" },
    { key: "endDate", label: "结束时间" }, { key: "location", label: "地点" }, { key: "description", label: "职责与可核实成果", wide: true, multiline: true },
  ] },
  project: { container: "projectEntries", fields: [
    { key: "name", label: "项目名称" }, { key: "role", label: "负责内容" }, { key: "startDate", label: "开始时间" },
    { key: "endDate", label: "结束时间" }, { key: "link", label: "项目链接" }, { key: "description", label: "项目描述与成果", wide: true, multiline: true },
  ] },
  award: { container: "awardEntries", fields: [
    { key: "name", label: "奖项名称" }, { key: "organization", label: "颁发组织" }, { key: "date", label: "获奖时间" },
    { key: "description", label: "补充说明", wide: true, multiline: true },
  ] },
};

const ENTRY_PROFILE_KEYS: Record<EntryGroup, keyof ProfileData> = {
  education: "educationEntries", experience: "experienceEntries", project: "projectEntries", award: "awardEntries",
};

function setBadge(message: string, kind: "normal" | "success" | "error" = "normal") {
  saveBadge.textContent = message;
  saveBadge.className = `save-state ${kind === "normal" ? "" : kind}`;
}

function setNamedValue(name: string, value: string, onlyIfEmpty = false) {
  const input = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!input || (onlyIfEmpty && input.value.trim())) return;
  input.value = value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function newEntry(group: EntryGroup): EntryRecord {
  const id = crypto.randomUUID();
  if (group === "education") return { id, school: "", major: "", degree: "", startDate: "", endDate: "", gpa: "", description: "" };
  if (group === "experience") return { id, organization: "", role: "", startDate: "", endDate: "", location: "", description: "" };
  if (group === "project") return { id, name: "", role: "", startDate: "", endDate: "", link: "", description: "" };
  return { id, name: "", organization: "", date: "", description: "" };
}

function renderEntryGroup(group: EntryGroup, entries: EntryRecord[]) {
  const container = document.querySelector<HTMLElement>(`#${ENTRY_CONFIG[group].container}`)!;
  if (!entries.length) {
    container.innerHTML = `<p class="entry-empty">暂未添加记录，可点击右上角“新增”。</p>`;
    return;
  }
  container.innerHTML = entries.map((entry, index) => `<div class="entry-card" data-entry-id="${escapeHtml(entry.id)}">
    <div class="entry-controls"><button data-move-entry="up" type="button" ${index === 0 ? "disabled" : ""}>↑</button><button data-move-entry="down" type="button" ${index === entries.length - 1 ? "disabled" : ""}>↓</button><button class="remove-entry" data-remove-entry="${group}" type="button">删除第 ${index + 1} 条</button></div>
    ${ENTRY_CONFIG[group].fields.map((field) => `<label class="${field.wide ? "entry-wide" : ""}">${field.label}${field.multiline ? `<textarea data-entry-field="${field.key}" rows="3">${escapeHtml(String(entry[field.key as keyof EntryRecord] ?? ""))}</textarea>` : `<input data-entry-field="${field.key}" value="${escapeHtml(String(entry[field.key as keyof EntryRecord] ?? ""))}" />`}</label>`).join("")}
  </div>`).join("");
}

function renderEntryGroups(profile: ProfileData) {
  for (const group of Object.keys(ENTRY_CONFIG) as EntryGroup[]) {
    renderEntryGroup(group, (profile[ENTRY_PROFILE_KEYS[group]] as unknown as EntryRecord[]) ?? []);
  }
}

function readEntryGroup(group: EntryGroup): EntryRecord[] {
  const container = document.querySelector<HTMLElement>(`#${ENTRY_CONFIG[group].container}`)!;
  return Array.from(container.querySelectorAll<HTMLElement>(".entry-card")).map((card) => {
    const entry = newEntry(group) as unknown as Record<string, string>;
    entry.id = card.dataset.entryId || crypto.randomUUID();
    for (const field of ENTRY_CONFIG[group].fields) {
      const input = card.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-entry-field="${field.key}"]`);
      entry[field.key] = input?.value.trim() ?? "";
    }
    return entry as unknown as EntryRecord;
  });
}

function formatEntries(entries: EntryRecord[], group: EntryGroup): string {
  return entries.map((entry) => {
    if (group === "education") {
      const item = entry as EducationEntry;
      return [item.school, item.degree, item.major, [item.startDate, item.endDate].filter(Boolean).join(" - "), item.gpa && `GPA ${item.gpa}`, item.description].filter(Boolean).join("｜");
    }
    if (group === "experience") {
      const item = entry as ExperienceEntry;
      return [[item.organization, item.role].filter(Boolean).join(" · "), [item.startDate, item.endDate].filter(Boolean).join(" - "), item.location, item.description].filter(Boolean).join("\n");
    }
    if (group === "project") {
      const item = entry as ProjectEntry;
      return [[item.name, item.role].filter(Boolean).join(" · "), [item.startDate, item.endDate].filter(Boolean).join(" - "), item.link, item.description].filter(Boolean).join("\n");
    }
    const item = entry as AwardEntry;
    return [[item.name, item.organization].filter(Boolean).join(" · "), item.date, item.description].filter(Boolean).join("｜");
  }).filter(Boolean).join("\n\n");
}

function applyState(state: StoredState, key: string) {
  for (const field of PROFILE_FIELD_KEYS) setNamedValue(field, state.profile[field]);
  renderEntryGroups(state.profile);
  rawText.value = state.profile.resumeRawText;
  aiEnabled.checked = state.ai.enabled;
  aiBaseUrl.value = state.ai.baseUrl;
  aiModel.value = state.ai.model;
  aiKey.value = key;
  rememberKey.checked = state.ai.rememberKey;
  aiInstructions.value = state.ai.instructions;
  toggleAi();
}

function readState(): StoredState {
  const profile = Object.fromEntries(PROFILE_FIELD_KEYS.map((field) => {
    const input = form.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement;
    return [field, input.value.trim()];
  })) as unknown as ProfileData;
  profile.resumeRawText = rawText.value.trim();
  profile.educationEntries = readEntryGroup("education") as EducationEntry[];
  profile.experienceEntries = readEntryGroup("experience") as ExperienceEntry[];
  profile.projectEntries = readEntryGroup("project") as ProjectEntry[];
  profile.awardEntries = readEntryGroup("award") as AwardEntry[];
  const education = profile.educationEntries[0];
  if (education) {
    profile.school = education.school || profile.school;
    profile.major = education.major || profile.major;
    profile.degree = education.degree || profile.degree;
    profile.educationStart = education.startDate || profile.educationStart;
    profile.educationEnd = education.endDate || profile.educationEnd;
    profile.gpa = education.gpa || profile.gpa;
  }
  if (profile.experienceEntries.length) profile.experience = formatEntries(profile.experienceEntries, "experience");
  if (profile.projectEntries.length) profile.projects = formatEntries(profile.projectEntries, "project");
  if (profile.awardEntries.length) profile.awards = formatEntries(profile.awardEntries, "award");
  return {
    schemaVersion: 1,
    profile,
    ai: {
      enabled: aiEnabled.checked,
      baseUrl: aiBaseUrl.value.trim().replace(/\/$/, ""),
      model: aiModel.value.trim(),
      rememberKey: rememberKey.checked,
      instructions: aiInstructions.value.trim() || DEFAULT_STATE.ai.instructions,
    },
  };
}

function toggleAi() {
  aiSettings.classList.toggle("disabled", !aiEnabled.checked);
}

function inferProfile(text: string): Partial<ProfileData> {
  const normalized = text.replace(/\r/g, "").replace(/[\t ]+/g, " ");
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const email = normalized.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? "";
  const phone = normalized.match(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/)?.[0]?.replace(/^(?:\+?86[- ]?)/, "") ?? "";
  const fullName = lines.slice(0, 12).find((line) => /^[\u4e00-\u9fa5·]{2,6}$/.test(line)) ?? "";
  const schoolLine = lines.find((line) => /(大学|学院|University|College)/i.test(line)) ?? "";
  const degree = normalized.match(/(博士|硕士|本科|大专|高中|Ph\.?D|Master(?:'s)?|Bachelor(?:'s)?)/i)?.[0] ?? "";
  const github = normalized.match(/https?:\/\/(?:www\.)?github\.com\/[\w.-]+/i)?.[0] ?? "";
  const website = normalized.match(/https?:\/\/(?!.*github\.com)[^\s<>]+/i)?.[0] ?? "";
  const majorLine = lines.find((line) => /(专业|Major)[:： ]/i.test(line));
  return {
    fullName,
    email,
    phone,
    school: schoolLine.replace(/[|｜].*$/, "").trim(),
    degree,
    major: majorLine?.replace(/^.*?(?:专业|Major)[:： ]*/i, "").split(/[|｜]/)[0].trim() ?? "",
    github,
    website,
  };
}

async function extractPdf(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: string[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return pages.join("\n");
}

async function extractResume(file: File): Promise<string> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".pdf")) return extractPdf(file);
  if (lowerName.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  if (lowerName.endsWith(".json")) {
    const json = JSON.parse(await file.text());
    return typeof json === "string" ? json : JSON.stringify(json, null, 2);
  }
  return file.text();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) {
    importState.textContent = "文件超过 12 MB，请压缩后再试。";
    return;
  }
  importState.textContent = "正在本地解析…";
  try {
    const text = (await extractResume(file)).trim();
    if (!text) throw new Error("没有提取到可读文字，扫描版 PDF 需要后续接入 OCR。 ");
    rawText.value = text;
    const inferred = inferProfile(text);
    for (const [name, value] of Object.entries(inferred)) {
      if (typeof value === "string" && value) setNamedValue(name, value, true);
    }
    importState.textContent = `已从 ${file.name} 提取 ${text.length.toLocaleString()} 个字符。请校对后保存。`;
    setBadge("有未保存修改");
  } catch (error) {
    importState.textContent = error instanceof Error ? error.message : "解析失败，请改用手动填写。";
  } finally {
    fileInput.value = "";
  }
});

form.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const addButton = target.closest<HTMLButtonElement>("[data-add-entry]");
  if (addButton) {
    const group = addButton.dataset.addEntry as EntryGroup;
    const entries = readEntryGroup(group);
    entries.push(newEntry(group));
    renderEntryGroup(group, entries);
    setBadge("有未保存修改");
    return;
  }
  const removeButton = target.closest<HTMLButtonElement>("[data-remove-entry]");
  const card = removeButton?.closest<HTMLElement>(".entry-card");
  if (removeButton && card) {
    const group = removeButton.dataset.removeEntry as EntryGroup;
    const entries = readEntryGroup(group).filter((entry) => entry.id !== card.dataset.entryId);
    renderEntryGroup(group, entries);
    setBadge("有未保存修改");
    return;
  }
  const moveButton = target.closest<HTMLButtonElement>("[data-move-entry]");
  const moveCard = moveButton?.closest<HTMLElement>(".entry-card");
  if (!moveButton || !moveCard) return;
  const moveGroup = moveCard.parentElement?.id.replace(/Entries$/, "") as EntryGroup;
  const entries = readEntryGroup(moveGroup);
  const currentIndex = entries.findIndex((entry) => entry.id === moveCard.dataset.entryId);
  const nextIndex = moveButton.dataset.moveEntry === "up" ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= entries.length) return;
  [entries[currentIndex], entries[nextIndex]] = [entries[nextIndex], entries[currentIndex]];
  renderEntryGroup(moveGroup, entries);
  setBadge("有未保存修改");
});

aiEnabled.addEventListener("change", toggleAi);
form.addEventListener("input", () => setBadge("有未保存修改"));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const state = readState();
    if (state.ai.enabled && (!state.ai.baseUrl || !state.ai.model)) {
      throw new Error("启用 AI 后需要填写接口地址和模型名称。 ");
    }
    await saveState(state, aiKey.value.trim());
    setBadge("已保存到本机", "success");
  } catch (error) {
    setBadge(error instanceof Error ? error.message : "保存失败", "error");
  }
});

document.querySelector("#authorizeAi")!.addEventListener("click", async () => {
  try {
    const url = new URL(aiBaseUrl.value.trim());
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new Error("AI 接口必须使用 HTTPS；本机 localhost 除外。 ");
    }
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    setBadge(granted ? "已授权 AI 接口" : "未授权 AI 接口", granted ? "success" : "error");
  } catch (error) {
    setBadge(error instanceof Error ? error.message : "地址无效", "error");
  }
});

document.querySelector("#clearProfile")!.addEventListener("click", async () => {
  if (!window.confirm("确定清空当前浏览器中保存的个人资料和 API Key 吗？")) return;
  await clearState();
  form.reset();
  rawText.value = "";
  applyState(DEFAULT_STATE, "");
  setBadge("本机资料已清空", "success");
});

Promise.all([loadState(), getApiKey()]).then(([state, key]) => {
  applyState(state, key);
  setBadge("已加载本机资料");
});

import "./app.css";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as mammoth from "mammoth/mammoth.browser";
import { clearState, getApiKey, loadState, saveState } from "./storage";
import { DEFAULT_STATE, PROFILE_FIELD_KEYS, type ProfileData, type StoredState } from "./types";

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

function setBadge(message: string, kind: "normal" | "success" | "error" = "normal") {
  saveBadge.textContent = message;
  saveBadge.className = `save-state ${kind === "normal" ? "" : kind}`;
}

function setNamedValue(name: string, value: string, onlyIfEmpty = false) {
  const input = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!input || (onlyIfEmpty && input.value.trim())) return;
  input.value = value;
}

function applyState(state: StoredState, key: string) {
  for (const field of PROFILE_FIELD_KEYS) setNamedValue(field, state.profile[field]);
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
  })) as ProfileData;
  profile.resumeRawText = rawText.value.trim();
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
      if (value) setNamedValue(name, value, true);
    }
    importState.textContent = `已从 ${file.name} 提取 ${text.length.toLocaleString()} 个字符。请校对后保存。`;
    setBadge("有未保存修改");
  } catch (error) {
    importState.textContent = error instanceof Error ? error.message : "解析失败，请改用手动填写。";
  } finally {
    fileInput.value = "";
  }
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


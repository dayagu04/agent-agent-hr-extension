import "./app.css";

const status = document.querySelector<HTMLElement>("#status")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;

document.querySelector("#profile")!.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "OPEN_PROFILE_PAGE" }) as { ok?: boolean; error?: string };
  if (response.ok) window.close();
  else status.textContent = response.error || "无法打开网申资料页。";
});

async function openAssistant() {
  startButton.disabled = true;
  status.textContent = "正在打开助手…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) {
      throw new Error("当前页面不允许扩展运行，请打开招聘网站后重试。 ");
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "OPEN_ASSISTANT" }) as { ok?: boolean } | undefined;
    if (response?.ok !== true) throw new Error("助手内容脚本未能启动，请刷新招聘页面后重试。");
    window.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取当前页面。";
    status.textContent = /Receiving end does not exist|message port closed/i.test(message)
      ? "助手内容脚本未启动。请确认已加载最新版扩展，刷新招聘页面后重试。"
      : message;
    startButton.disabled = false;
  }
}

startButton.addEventListener("click", openAssistant);

status.textContent = "打开我的简历，点击开始填写。";
startButton.disabled = false;


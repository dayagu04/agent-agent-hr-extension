import "./app.css";
import { hasUsableProfile, loadState } from "./storage";

const status = document.querySelector<HTMLElement>("#status")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;

document.querySelector("#profile")!.addEventListener("click", () => chrome.runtime.openOptionsPage());

async function openAssistant() {
  startButton.disabled = true;
  status.textContent = "正在识别当前页面的可填写字段…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) {
      throw new Error("当前页面不允许扩展运行，请打开招聘网站后重试。 ");
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "OPEN_ASSISTANT" });
    window.close();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "无法读取当前页面。";
    startButton.disabled = false;
  }
}

startButton.addEventListener("click", openAssistant);

loadState().then((state) => {
  if (hasUsableProfile(state)) {
    status.textContent = "个人档案已就绪。点击后会在当前页面显示字段预览，不会直接提交。";
    startButton.disabled = false;
  } else {
    status.textContent = "还没有个人档案，请先导入简历或手动填写。";
    startButton.disabled = true;
  }
});


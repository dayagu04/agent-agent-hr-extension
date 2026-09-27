import { getApiKey, loadState } from "./storage";
import type { PolishRequest } from "./types";

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

async function polishText(request: PolishRequest): Promise<string> {
  const state = await loadState();
  if (!state.ai.enabled) throw new Error("请先在个人档案中启用 AI 辅助。 ");
  const key = await getApiKey();
  if (!key) throw new Error("没有可用的 API Key，请在个人档案中配置。 ");
  const url = new URL(state.ai.baseUrl);
  const allowed = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
  if (!allowed) throw new Error("尚未授权访问该 AI 接口，请返回个人档案完成授权。 ");

  const response = await fetch(endpoint(state.ai.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: state.ai.model,
      temperature: 0.45,
      messages: [
        {
          role: "system",
          content: [
            "你是求职材料编辑。只优化用户已经提供的事实，让表达更贴合目标企业和问题。",
            "禁止虚构公司、学历、岗位、职责、奖项、日期、技术、指标和成果；不得添加原文无法支持的数字。",
            "直接返回可粘贴的正文，不要解释过程，不要使用 Markdown 标题。",
            state.ai.instructions,
          ].join("\n"),
        },
        {
          role: "user",
          content: `企业和页面语境：${request.companyContext}\n字段或问题：${request.question}\n待润色原文：\n${request.sourceText}`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`AI 接口返回 ${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const result = body.choices?.[0]?.message?.content?.trim();
  if (!result) throw new Error("AI 接口没有返回可用文本。 ");
  return result;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const payload = message as { type?: string; request?: PolishRequest };
  if (payload.type === "GET_ASSISTANT_STATE") {
    loadState().then((state) => {
      const { apiKey: _secret, ...safeState } = state;
      sendResponse({ ok: true, state: safeState });
    }, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (payload.type === "POLISH_TEXT" && payload.request) {
    polishText(payload.request).then((text) => sendResponse({ ok: true, text }), (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  return false;
});

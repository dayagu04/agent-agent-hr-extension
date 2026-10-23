import { DEFAULT_STATE, EMPTY_PROFILE, type StoredState } from "./types";

const STATE_KEY = "guguApplicationAssistant";
const SESSION_KEY = "guguLlmApiKey";

export async function loadState(): Promise<StoredState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  const raw = stored[STATE_KEY] as Partial<StoredState> | undefined;
  return {
    ...DEFAULT_STATE,
    ...raw,
    schemaVersion: 1,
    profile: { ...EMPTY_PROFILE, ...(raw?.profile ?? {}) },
    ai: { ...DEFAULT_STATE.ai, ...(raw?.ai ?? {}) },
  };
}

export async function saveState(state: StoredState, apiKey: string): Promise<void> {
  const next: StoredState = {
    ...state,
    apiKey: state.ai.rememberKey && apiKey ? apiKey : undefined,
  };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  if (apiKey) {
    await chrome.storage.session.set({ [SESSION_KEY]: apiKey });
  } else {
    await chrome.storage.session.remove(SESSION_KEY);
  }
}

export async function getApiKey(): Promise<string> {
  const session = await chrome.storage.session.get(SESSION_KEY);
  if (typeof session[SESSION_KEY] === "string" && session[SESSION_KEY]) return session[SESSION_KEY];
  const state = await loadState();
  return state.apiKey ?? "";
}

export async function clearState(): Promise<void> {
  await Promise.all([
    chrome.storage.local.remove(STATE_KEY),
    chrome.storage.session.remove(SESSION_KEY),
  ]);
}

export function hasUsableProfile(state: StoredState): boolean {
  return Boolean(state.profile.fullName || state.profile.phone || state.profile.email || state.profile.resumeRawText);
}


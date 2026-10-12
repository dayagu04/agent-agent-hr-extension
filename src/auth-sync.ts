const TOKEN_KEY = "token";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForPendingBridge(): Promise<boolean> {
  const isAutofillLogin = new URLSearchParams(location.search).get("product") === "application-autofill";
  const attempts = isAutofillLogin ? 20 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await chrome.runtime.sendMessage({ type: "AUTH_BRIDGE_STATUS" }) as {
      ok?: boolean;
      result?: boolean;
    };
    if (status.ok && status.result === true) return true;
    if (attempt + 1 < attempts) await delay(250);
  }
  return false;
}

async function startAuthSync(): Promise<void> {
  if (!await waitForPendingBridge()) return;

  let attemptedToken = "";
  let attemptCount = 0;
  let nextAttemptAt = 0;
  const trySync = async () => {
    const token = window.localStorage.getItem(TOKEN_KEY) ?? "";
    if (!token) return false;
    if (token !== attemptedToken) {
      attemptedToken = token;
      attemptCount = 0;
      nextAttemptAt = 0;
    }
    if (Date.now() < nextAttemptAt) return false;
    const response = await chrome.runtime.sendMessage({ type: "SYNC_AUTOFILL_TOKEN", token }) as { ok?: boolean };
    if (response.ok === true) return true;
    attemptCount += 1;
    nextAttemptAt = Date.now() + Math.min(15_000, 1_000 * 2 ** Math.min(attemptCount, 4));
    return false;
  };

  if (await trySync()) return;
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      window.clearInterval(timer);
      return;
    }
    void trySync().then((synced) => {
      if (synced) window.clearInterval(timer);
    });
  }, 1_000);
}

void startAuthSync();

export const AUTOFILL_FIRST_PARTY_ORIGINS = new Set([
  "https://gudaya.chat",
  "https://www.gudaya.chat",
]);

/** Expiry metadata only; authentication is still verified by the server. */
export function tokenExpiresAt(token: string): number {
  try {
    const part = token.split(".")[1];
    const encoded = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="))) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : 0;
  } catch { return 0; }
}

export interface PendingAuthBridge {
  loginTabId: number;
  requestTabId?: number;
  expiresAt: number;
}

export function isTrustedAutofillFirstPartyUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return AUTOFILL_FIRST_PARTY_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

export function canUsePendingAuthBridge(
  senderUrl: string | undefined,
  senderTabId: number | undefined,
  pending: PendingAuthBridge | null,
  now = Date.now(),
): boolean {
  return Boolean(
    pending
      && isTrustedAutofillFirstPartyUrl(senderUrl)
      && senderTabId === pending.loginTabId
      && Number.isFinite(pending.expiresAt)
      && pending.expiresAt > now,
  );
}

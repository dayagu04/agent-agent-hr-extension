export const AUTOFILL_FIRST_PARTY_ORIGINS = new Set([
  "https://gudaya.chat",
  "https://www.gudaya.chat",
]);

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

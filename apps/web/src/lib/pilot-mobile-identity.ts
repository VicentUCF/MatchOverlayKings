const identities = new Map<string, string>();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Retain this tab's ownership across reloads without storing the camera token. */
export function mobileClientIdentity(endpoint: string, sessionId: string): string {
  const key = `kpl.mobile-client:${endpoint}:${sessionId}`;
  try {
    const saved = window.sessionStorage.getItem(key);
    if (saved && UUID.test(saved)) { identities.set(key, saved); return saved; }
  } catch { /* Storage can be unavailable in private or embedded browsers. */ }
  const identity = identities.get(key) ?? crypto.randomUUID();
  identities.set(key, identity);
  try { window.sessionStorage.setItem(key, identity); } catch { /* Keep this page usable. */ }
  return identity;
}

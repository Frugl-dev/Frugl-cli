import { defaultSessionStore, type AuthSession } from "./session-store.js";

// Stable function facade over the process-wide SessionStore. The schema,
// keychain keying, and corruption semantics now live in session-store.ts (the
// deep module); these wrappers keep the existing call sites unchanged.
export type { AuthSession } from "./session-store.js";

export async function saveAuthSession(session: AuthSession): Promise<void> {
  return defaultSessionStore.save(session);
}

export async function loadAuthSession(endpointUrl: string): Promise<AuthSession | null> {
  return defaultSessionStore.loadOrNull(endpointUrl);
}

export async function requireAuthSession(endpointUrl: string): Promise<AuthSession> {
  return defaultSessionStore.require(endpointUrl);
}

export async function clearAuthSession(endpointUrl: string): Promise<void> {
  return defaultSessionStore.clear(endpointUrl);
}

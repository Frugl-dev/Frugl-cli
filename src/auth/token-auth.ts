import { SessionStore, defaultSessionStore, type ResolvedToken } from "./session-store.js";

// Stable function facade over SessionStore.resolveToken. The precedence logic
// (flag > env > stored session) lives in the deep module; this wrapper keeps
// the existing `resolveHeadlessToken({ env })` call shape. When a token is
// resolved in a non-interactive context, the caller MUST use it and MUST NOT
// fall back to interactive OTP login.
export type { TokenSource, ResolvedToken } from "./session-store.js";

export interface ResolveTokenOptions {
  flagToken?: string | undefined;
  endpointUrl: string;
  // Injectable for tests; defaults to process.env.
  env?: NodeJS.ProcessEnv | undefined;
}

export async function resolveHeadlessToken(
  opts: ResolveTokenOptions,
): Promise<ResolvedToken | null> {
  const store = opts.env ? new SessionStore({ env: opts.env }) : defaultSessionStore;
  return store.resolveToken({ flagToken: opts.flagToken, endpointUrl: opts.endpointUrl });
}

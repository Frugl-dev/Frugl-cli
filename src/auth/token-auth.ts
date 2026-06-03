import { loadAuthSession } from "./session.js";

// Resolves the credential for a non-interactive (headless) run. Precedence:
//   1. --token flag        (explicit, one-off override)
//   2. FRUGL_TOKEN env var  (the natural CI / secret-store mechanism)
//   3. stored keychain session token (developer who ran `frugl login`)
// When a token is resolved in a non-interactive context, the caller MUST use it
// and MUST NOT fall back to interactive OTP login.

export type TokenSource = "flag" | "env" | "session";

export interface ResolveTokenOptions {
  flagToken?: string | undefined;
  endpointUrl: string;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

export async function resolveHeadlessToken(
  opts: ResolveTokenOptions,
): Promise<ResolvedToken | null> {
  const env = opts.env ?? process.env;

  const flag = opts.flagToken?.trim();
  if (flag) return { token: flag, source: "flag" };

  const envToken = env.FRUGL_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "env" };

  const session = await loadAuthSession(opts.endpointUrl);
  if (session?.token) return { token: session.token, source: "session" };

  return null;
}

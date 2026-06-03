import { z } from "zod";
import { AuthError } from "../lib/errors.js";
import { keychainCredentialStore, type CredentialStore } from "./credential-store.js";

const authSessionSchema = z.object({
  email: z.string().email(),
  userId: z.string().min(1),
  token: z.string().min(1),
  endpointUrl: z.string().url(),
  loggedInAt: z.string().datetime(),
});

export type AuthSession = z.infer<typeof authSessionSchema>;

// A stored session is read back as exactly one of three states. Distinguishing
// "corrupted" from "none" matters: previously a malformed/invalid stored
// session was collapsed to null, silently indistinguishable from "never logged
// in", so a corrupted keychain entry quietly triggered a re-login instead of
// telling the user their stored credential is unreadable.
export type SessionLoad =
  | { kind: "session"; session: AuthSession }
  | { kind: "none" }
  | { kind: "corrupted"; reason: string };

export type TokenSource = "flag" | "env" | "session";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

export interface SessionStoreOptions {
  // Credential backend; defaults to the OS keychain adapter.
  store?: CredentialStore;
  // Environment for FRUGL_TOKEN resolution; defaults to process.env.
  env?: NodeJS.ProcessEnv;
}

// Deep module owning everything about the persisted auth session: the on-disk
// schema, the keychain account keying, load/corruption semantics, and the
// headless token precedence (flag > env > stored session). Both dependencies —
// the credential backend and the environment — are injected, so the whole
// module is tested through this interface with an in-memory adapter rather than
// by mocking individual free functions.
export class SessionStore {
  private readonly store: CredentialStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: SessionStoreOptions = {}) {
    this.store = opts.store ?? keychainCredentialStore;
    this.env = opts.env ?? process.env;
  }

  async save(session: AuthSession): Promise<void> {
    await this.store.set(accountFor(session.endpointUrl), JSON.stringify(session));
  }

  async load(endpointUrl: string): Promise<SessionLoad> {
    const raw = await this.store.get(accountFor(endpointUrl));
    if (!raw) return { kind: "none" };
    try {
      return { kind: "session", session: authSessionSchema.parse(JSON.parse(raw)) };
    } catch (err) {
      return { kind: "corrupted", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // The stored session, or null when absent OR unreadable. Preserves the legacy
  // `loadAuthSession` contract for callers that only branch on presence.
  async loadOrNull(endpointUrl: string): Promise<AuthSession | null> {
    const result = await this.load(endpointUrl);
    return result.kind === "session" ? result.session : null;
  }

  async require(endpointUrl: string): Promise<AuthSession> {
    const result = await this.load(endpointUrl);
    if (result.kind === "session") return result.session;
    if (result.kind === "corrupted") {
      throw new AuthError(
        `Stored login is unreadable (${result.reason}). Run 'frugl login' to re-authenticate.`,
      );
    }
    throw new AuthError("Not logged in. Run 'frugl login' to authenticate.");
  }

  async clear(endpointUrl: string): Promise<void> {
    await this.store.delete(accountFor(endpointUrl));
  }

  // Headless credential precedence:
  //   1. --token flag        (explicit, one-off override)
  //   2. FRUGL_TOKEN env var  (CI / secret-store mechanism)
  //   3. stored session token (developer who ran `frugl login`)
  // Returns null when no credential is available anywhere.
  async resolveToken(opts: {
    flagToken?: string | undefined;
    endpointUrl: string;
  }): Promise<ResolvedToken | null> {
    const flag = opts.flagToken?.trim();
    if (flag) return { token: flag, source: "flag" };

    const envToken = this.env.FRUGL_TOKEN?.trim();
    if (envToken) return { token: envToken, source: "env" };

    const session = await this.loadOrNull(opts.endpointUrl);
    if (session?.token) return { token: session.token, source: "session" };

    return null;
  }
}

function accountFor(endpointUrl: string): string {
  return endpointUrl;
}

// Process-wide store backed by the real OS keychain. The thin function facades
// in session.ts / token-auth.ts delegate here so existing callers are
// unchanged while the depth lives in one tested place.
export const defaultSessionStore = new SessionStore();

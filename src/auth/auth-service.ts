import { AuthError } from "../lib/errors.js";
import { clearPendingAuthFailure } from "../lib/config.js";
import type { IdentityClient } from "./identity-client.js";
import { SessionStore, type AuthSession } from "./session-store.js";

// Clear the background-auth-failure breadcrumb after a fresh session lands. Any
// successful login means the token is good again, so the next interactive
// command should stop nagging. Best-effort: a config write failure must never
// fail an otherwise-successful login.
function clearAuthFailureBreadcrumb(endpointUrl: string): void {
  try {
    clearPendingAuthFailure(endpointUrl);
  } catch {
    /* ignore — the breadcrumb is a convenience, not a contract */
  }
}

export interface AuthServiceOptions {
  endpointUrl: string;
  // Injected network port for the auth endpoints (OTP + whoami).
  identity: IdentityClient;
  // Persistence + precedence. Defaults to a SessionStore for `endpointUrl`
  // backed by the real keychain; tests inject one over an in-memory store.
  sessions?: SessionStore;
}

// Deep facade owning the entire "which credential authorizes this request, and
// who is the acting identity" decision. It wraps a network-free SessionStore
// (persistence + flag > env > session precedence) and an injected IdentityClient
// (OTP + whoami). Callers never see the ResolvedToken.source branching, never
// construct CloudClients for auth, and never re-read the keychain to recover the
// identity behind a session-sourced token.
export class AuthService {
  private readonly endpointUrl: string;
  private readonly identity: IdentityClient;
  private readonly sessions: SessionStore;

  constructor(opts: AuthServiceOptions) {
    this.endpointUrl = opts.endpointUrl;
    this.identity = opts.identity;
    this.sessions = opts.sessions ?? new SessionStore();
  }

  // Interactive OTP login — step 1: ask the server to email a code.
  async startLogin(email: string): Promise<void> {
    await this.identity.requestOtp(email);
  }

  // Interactive OTP login — step 2: verify the code, then persist the session.
  // The verify response omits the email (account-enumeration sensitive), so we
  // keep the address the user entered. Stamps loggedInAt and saves before
  // returning, so callers get a persisted, ready-to-replay session.
  async completeLogin(email: string, code: string): Promise<AuthSession> {
    const { userId, token } = await this.identity.verifyOtp(email, code);
    const session: AuthSession = {
      email,
      userId,
      token,
      endpointUrl: this.endpointUrl,
      loggedInAt: new Date().toISOString(),
    };
    await this.sessions.save(session);
    clearAuthFailureBreadcrumb(this.endpointUrl);
    return session;
  }

  // Headless `login --token`: validate a pre-issued token against the server,
  // then persist it as a session. The whoami call also rejects a bad token
  // (AuthError) before anything is written to the keychain.
  async loginWithToken(token: string): Promise<AuthSession> {
    const identity = await this.identity.fetchIdentity(token);
    const session: AuthSession = {
      email: identity.email,
      userId: identity.userId,
      token,
      endpointUrl: this.endpointUrl,
      loggedInAt: new Date().toISOString(),
    };
    await this.sessions.save(session);
    clearAuthFailureBreadcrumb(this.endpointUrl);
    return session;
  }

  // Non-interactive resolution (upload, hooks) — the ONE entry point for "what
  // credential authorizes this request". Resolves flag > env > stored session
  // via SessionStore in a single keychain read. For a session-sourced token the
  // identity is already in the stored session, so whoami is NEVER called; for a
  // flag/env token the identity is fetched from the server. Throws AuthError
  // when nothing is available (the run exits non-zero rather than prompting).
  async resolveRequestAuth(opts: { flagToken?: string | undefined }): Promise<AuthSession> {
    const resolved = await this.sessions.resolveAuth({
      flagToken: opts.flagToken,
      endpointUrl: this.endpointUrl,
    });

    if (!resolved) {
      throw new AuthError("Not logged in. Run 'frugl login', or set FRUGL_TOKEN for CI / hooks.");
    }

    if (resolved.source === "session") {
      return resolved.session;
    }

    const identity = await this.identity.fetchIdentity(resolved.token);
    return {
      email: identity.email,
      userId: identity.userId,
      token: resolved.token,
      endpointUrl: this.endpointUrl,
      loggedInAt: new Date().toISOString(),
    };
  }
}

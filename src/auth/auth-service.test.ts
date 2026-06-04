import { describe, it, expect } from "vitest";
import { AuthService } from "./auth-service.js";
import { SessionStore, type AuthSession } from "./session-store.js";
import { createInMemoryCredentialStore, type CredentialStore } from "./credential-store.js";
import type { IdentityClient } from "./identity-client.js";
import { AuthError } from "../lib/errors.js";

const endpointUrl = "https://frugl.example";

const storedSession: AuthSession = {
  email: "me@acme.dev",
  userId: "u_stored",
  token: "tok_stored",
  endpointUrl,
  loggedInAt: "2026-05-26T00:00:00.000Z",
};

// In-memory IdentityClient fake. Canned identities keyed by token; unknown
// tokens are treated as revoked and throw AuthError (mirroring CloudClient's
// 401/403 -> AuthError). Records every call for assertions.
interface FakeIdentity extends IdentityClient {
  readonly otpRequests: string[];
  readonly fetchIdentityCalls: string[];
}

function makeIdentity(
  opts: {
    identities?: Record<string, { userId: string; email: string }>;
    verify?: Record<string, { userId: string; token: string }>;
  } = {},
): FakeIdentity {
  const identities = opts.identities ?? {};
  const verify = opts.verify ?? {};
  const otpRequests: string[] = [];
  const fetchIdentityCalls: string[] = [];
  return {
    otpRequests,
    fetchIdentityCalls,
    async requestOtp(email) {
      otpRequests.push(email);
    },
    async verifyOtp(email, code) {
      const key = `${email}:${code}`;
      const result = verify[key];
      if (!result) throw new AuthError("Invalid code.");
      return result;
    },
    async fetchIdentity(token) {
      fetchIdentityCalls.push(token);
      const identity = identities[token];
      if (!identity) throw new AuthError("Authentication failed (401).");
      return identity;
    },
  };
}

// Counting CredentialStore wrapper — asserts how many keychain reads happen.
function countingStore(inner: CredentialStore): CredentialStore & { gets: number } {
  const wrapper = {
    gets: 0,
    async get(account: string) {
      wrapper.gets += 1;
      return inner.get(account);
    },
    set: inner.set.bind(inner),
    delete: inner.delete.bind(inner),
  };
  return wrapper;
}

interface MakeAuthServiceOptions {
  seed?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  identity?: FakeIdentity;
  store?: CredentialStore;
}

// Mirrors session-store.test.ts's `makeStore`: builds an AuthService over an
// in-memory CredentialStore + a fake IdentityClient. No vi.mock, no HTTP, no
// real keychain. Returns the pieces so tests can assert call counts.
function makeAuthService(opts: MakeAuthServiceOptions = {}) {
  const credentials = opts.store ?? createInMemoryCredentialStore(opts.seed);
  const sessions = new SessionStore({ store: credentials, env: opts.env ?? {} });
  const identity = opts.identity ?? makeIdentity();
  const service = new AuthService({ endpointUrl, identity, sessions });
  return { service, sessions, identity, credentials };
}

describe("AuthService OTP login", () => {
  it("startLogin requests an OTP for the email", async () => {
    const { service, identity } = makeAuthService();
    await service.startLogin("new@acme.dev");
    expect(identity.otpRequests).toEqual(["new@acme.dev"]);
  });

  it("completeLogin maps verify output into a session (keeping the user email) and persists it", async () => {
    const identity = makeIdentity({
      verify: { "new@acme.dev:123456": { userId: "u_new", token: "tok_new" } },
    });
    const { service, sessions } = makeAuthService({ identity });

    const session = await service.completeLogin("new@acme.dev", "123456");

    expect(session).toMatchObject({
      email: "new@acme.dev", // server omits the email; we keep what the user entered
      userId: "u_new",
      token: "tok_new",
      endpointUrl,
    });
    expect(session.loggedInAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    // Round-trips through the same SessionStore.
    expect(await sessions.require(endpointUrl)).toEqual(session);
  });
});

describe("AuthService.loginWithToken (headless --token)", () => {
  it("validates the token via the server, then persists the session", async () => {
    const identity = makeIdentity({
      identities: { frugl_pat_x: { userId: "u_ci", email: "ci@acme.dev" } },
    });
    const { service, sessions } = makeAuthService({ identity });

    const session = await service.loginWithToken("frugl_pat_x");

    expect(session).toMatchObject({ userId: "u_ci", email: "ci@acme.dev", token: "frugl_pat_x" });
    expect(identity.fetchIdentityCalls).toEqual(["frugl_pat_x"]);
    expect(await sessions.require(endpointUrl)).toEqual(session);
  });

  it("propagates AuthError for a revoked token and writes nothing", async () => {
    const { service, sessions } = makeAuthService();
    await expect(service.loginWithToken("frugl_pat_bad")).rejects.toBeInstanceOf(AuthError);
    expect(await sessions.loadOrNull(endpointUrl)).toBeNull();
  });
});

describe("AuthService.resolveRequestAuth precedence (through the real SessionStore)", () => {
  it("resolves identity from the server for an explicit --token flag", async () => {
    const identity = makeIdentity({
      identities: { frugl_pat_x: { userId: "u_flag", email: "flag@acme.dev" } },
    });
    const { service } = makeAuthService({ identity });

    const session = await service.resolveRequestAuth({ flagToken: "frugl_pat_x" });

    expect(session).toMatchObject({
      userId: "u_flag",
      email: "flag@acme.dev",
      token: "frugl_pat_x",
    });
    expect(identity.fetchIdentityCalls).toEqual(["frugl_pat_x"]);
  });

  it("uses FRUGL_TOKEN (server identity) when no flag is given", async () => {
    const identity = makeIdentity({
      identities: { env_pat: { userId: "u_env", email: "env@acme.dev" } },
    });
    const { service } = makeAuthService({ env: { FRUGL_TOKEN: "env_pat" }, identity });

    const session = await service.resolveRequestAuth({});

    expect(session.userId).toBe("u_env");
    expect(identity.fetchIdentityCalls).toEqual(["env_pat"]);
  });

  it("prefers the flag over env and the stored session", async () => {
    const identity = makeIdentity({
      identities: { flag_pat: { userId: "u_flag", email: "flag@acme.dev" } },
    });
    const { service } = makeAuthService({
      seed: { [endpointUrl]: JSON.stringify(storedSession) },
      env: { FRUGL_TOKEN: "env_pat" },
      identity,
    });

    const session = await service.resolveRequestAuth({ flagToken: "flag_pat" });
    expect(session.userId).toBe("u_flag");
  });
});

describe("AuthService.resolveRequestAuth double-load regression (the key one)", () => {
  it("session-sourced token: identity comes from the stored session, fetchIdentity is NEVER called, keychain read exactly once", async () => {
    const counting = countingStore(
      createInMemoryCredentialStore({
        [endpointUrl]: JSON.stringify(storedSession),
      }),
    );
    const { service, identity } = makeAuthService({ store: counting });

    const session = await service.resolveRequestAuth({});

    // Identity came from the stored session, not the server.
    expect(session).toEqual(storedSession);
    expect(identity.fetchIdentityCalls).toEqual([]);
    // The whole resolution read the keychain exactly once — no double load.
    expect(counting.gets).toBe(1);
  });

  it("flag/env token: fetchIdentity IS called and the keychain is read at most once", async () => {
    const counting = countingStore(
      createInMemoryCredentialStore({
        [endpointUrl]: JSON.stringify(storedSession),
      }),
    );
    const identity = makeIdentity({
      identities: { env_pat: { userId: "u_env", email: "env@acme.dev" } },
    });
    const { service } = makeAuthService({
      store: counting,
      env: { FRUGL_TOKEN: "env_pat" },
      identity,
    });

    await service.resolveRequestAuth({});

    expect(identity.fetchIdentityCalls).toEqual(["env_pat"]);
    // Flag/env short-circuits before the keychain is touched at all.
    expect(counting.gets).toBe(0);
  });
});

describe("AuthService.resolveRequestAuth failure modes", () => {
  it("throws AuthError when no credential is available anywhere (never falls through to OTP)", async () => {
    const { service, identity } = makeAuthService();
    await expect(service.resolveRequestAuth({})).rejects.toBeInstanceOf(AuthError);
    expect(identity.otpRequests).toEqual([]);
  });

  it("propagates AuthError from an invalid/revoked flag/env token", async () => {
    const { service } = makeAuthService({ env: { FRUGL_TOKEN: "frugl_pat_bad" } });
    await expect(service.resolveRequestAuth({})).rejects.toBeInstanceOf(AuthError);
  });
});

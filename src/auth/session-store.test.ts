import { describe, it, expect } from "vitest";
import { SessionStore, type AuthSession } from "./session-store.js";
import { createInMemoryCredentialStore } from "./credential-store.js";
import { AuthError } from "../lib/errors.js";

const endpointUrl = "https://frugl.example";

const session: AuthSession = {
  email: "me@acme.dev",
  userId: "u1",
  token: "tok_123",
  endpointUrl,
  loggedInAt: "2026-05-26T00:00:00.000Z",
};

function makeStore(opts: { seed?: Record<string, string>; env?: NodeJS.ProcessEnv } = {}) {
  const credentials = createInMemoryCredentialStore(opts.seed);
  return new SessionStore({ store: credentials, env: opts.env ?? {} });
}

describe("SessionStore persistence", () => {
  it("round-trips a saved session", async () => {
    const store = makeStore();
    await store.save(session);
    const result = await store.load(endpointUrl);
    expect(result).toEqual({ kind: "session", session });
  });

  it("reports `none` when nothing is stored", async () => {
    const store = makeStore();
    expect(await store.load(endpointUrl)).toEqual({ kind: "none" });
    expect(await store.loadOrNull(endpointUrl)).toBeNull();
  });

  it("reports `corrupted` for unparseable JSON and `loadOrNull` collapses it to null", async () => {
    const store = makeStore({ seed: { [endpointUrl]: "{not json" } });
    const result = await store.load(endpointUrl);
    expect(result.kind).toBe("corrupted");
    expect(await store.loadOrNull(endpointUrl)).toBeNull();
  });

  it("reports `corrupted` when the stored shape no longer validates", async () => {
    const store = makeStore({ seed: { [endpointUrl]: JSON.stringify({ email: "x" }) } });
    expect((await store.load(endpointUrl)).kind).toBe("corrupted");
  });

  it("clears a stored session", async () => {
    const store = makeStore();
    await store.save(session);
    await store.clear(endpointUrl);
    expect(await store.load(endpointUrl)).toEqual({ kind: "none" });
  });
});

describe("SessionStore.require", () => {
  it("returns the session when present", async () => {
    const store = makeStore();
    await store.save(session);
    expect(await store.require(endpointUrl)).toEqual(session);
  });

  it("throws a 'not logged in' AuthError when absent", async () => {
    const store = makeStore();
    await expect(store.require(endpointUrl)).rejects.toBeInstanceOf(AuthError);
    await expect(store.require(endpointUrl)).rejects.toThrow(/Not logged in/);
  });

  it("throws a distinct 'unreadable' AuthError when corrupted (not silently re-login)", async () => {
    const store = makeStore({ seed: { [endpointUrl]: "garbage" } });
    await expect(store.require(endpointUrl)).rejects.toBeInstanceOf(AuthError);
    await expect(store.require(endpointUrl)).rejects.toThrow(/unreadable/);
  });
});

describe("SessionStore.resolveToken precedence", () => {
  it("prefers the --token flag over env and session", async () => {
    const store = makeStore({
      seed: { [endpointUrl]: JSON.stringify(session) },
      env: { FRUGL_TOKEN: "env-token" },
    });
    expect(await store.resolveToken({ flagToken: "flag-token", endpointUrl })).toEqual({
      token: "flag-token",
      source: "flag",
    });
  });

  it("uses FRUGL_TOKEN when no flag is given", async () => {
    const store = makeStore({
      seed: { [endpointUrl]: JSON.stringify(session) },
      env: { FRUGL_TOKEN: "env-token" },
    });
    expect(await store.resolveToken({ endpointUrl })).toEqual({
      token: "env-token",
      source: "env",
    });
  });

  it("falls back to the stored session token", async () => {
    const store = makeStore({ seed: { [endpointUrl]: JSON.stringify(session) } });
    expect(await store.resolveToken({ endpointUrl })).toEqual({
      token: "tok_123",
      source: "session",
    });
  });

  it("ignores blank flag/env values", async () => {
    const store = makeStore({
      seed: { [endpointUrl]: JSON.stringify(session) },
      env: { FRUGL_TOKEN: "  " },
    });
    expect(await store.resolveToken({ flagToken: "   ", endpointUrl })).toEqual({
      token: "tok_123",
      source: "session",
    });
  });

  it("returns null when no credential is available anywhere", async () => {
    const store = makeStore();
    expect(await store.resolveToken({ endpointUrl })).toBeNull();
  });
});

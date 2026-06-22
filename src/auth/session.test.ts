import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "./session-store.js";

// session.ts is a thin facade over the process-wide `defaultSessionStore`. The
// only behavior worth pinning is that each free function delegates to the right
// store method with the right argument (and forwards the result). We mock the
// store module so nothing touches the real OS keychain.
const save = vi.fn<(session: AuthSession) => Promise<void>>();
const loadOrNull = vi.fn<(endpointUrl: string) => Promise<AuthSession | null>>();
const requireFn = vi.fn<(endpointUrl: string) => Promise<AuthSession>>();
const clear = vi.fn<(endpointUrl: string) => Promise<void>>();

vi.mock("./session-store.js", () => ({
  defaultSessionStore: {
    save: (s: AuthSession) => save(s),
    loadOrNull: (u: string) => loadOrNull(u),
    require: (u: string) => requireFn(u),
    clear: (u: string) => clear(u),
  },
}));

const { saveAuthSession, loadAuthSession, requireAuthSession, clearAuthSession } =
  await import("./session.js");

const endpointUrl = "https://frugl.example";
const session: AuthSession = {
  email: "me@acme.dev",
  userId: "u1",
  token: "tok_123",
  endpointUrl,
  loggedInAt: "2026-05-26T00:00:00.000Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("session.ts facade", () => {
  it("saveAuthSession forwards the session to defaultSessionStore.save", async () => {
    save.mockResolvedValue();
    await saveAuthSession(session);
    expect(save).toHaveBeenCalledExactlyOnceWith(session);
  });

  it("loadAuthSession delegates to loadOrNull and returns the session", async () => {
    loadOrNull.mockResolvedValue(session);
    expect(await loadAuthSession(endpointUrl)).toBe(session);
    expect(loadOrNull).toHaveBeenCalledExactlyOnceWith(endpointUrl);
  });

  it("loadAuthSession returns null when nothing is stored", async () => {
    loadOrNull.mockResolvedValue(null);
    expect(await loadAuthSession(endpointUrl)).toBeNull();
  });

  it("requireAuthSession delegates to require and returns the session", async () => {
    requireFn.mockResolvedValue(session);
    expect(await requireAuthSession(endpointUrl)).toBe(session);
    expect(requireFn).toHaveBeenCalledExactlyOnceWith(endpointUrl);
  });

  it("requireAuthSession propagates the store's rejection", async () => {
    const boom = new Error("Not logged in");
    requireFn.mockRejectedValue(boom);
    await expect(requireAuthSession(endpointUrl)).rejects.toBe(boom);
  });

  it("clearAuthSession delegates to clear for the endpoint", async () => {
    clear.mockResolvedValue();
    await clearAuthSession(endpointUrl);
    expect(clear).toHaveBeenCalledExactlyOnceWith(endpointUrl);
  });
});

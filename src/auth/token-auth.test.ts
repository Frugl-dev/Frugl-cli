import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveHeadlessToken } from "./token-auth.js";
import { loadAuthSession } from "./session.js";

vi.mock("./session.js", () => ({
  loadAuthSession: vi.fn<() => unknown>(),
}));

const endpointUrl = "https://poppi.example";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveHeadlessToken", () => {
  it("prefers the --token flag over env and session", async () => {
    (loadAuthSession as any).mockResolvedValue({ token: "session-token" });
    const resolved = await resolveHeadlessToken({
      flagToken: "flag-token",
      endpointUrl,
      env: { POPPI_TOKEN: "env-token" },
    });
    expect(resolved).toEqual({ token: "flag-token", source: "flag" });
    expect(loadAuthSession).not.toHaveBeenCalled();
  });

  it("uses POPPI_TOKEN when no flag is given", async () => {
    (loadAuthSession as any).mockResolvedValue({ token: "session-token" });
    const resolved = await resolveHeadlessToken({
      endpointUrl,
      env: { POPPI_TOKEN: "env-token" },
    });
    expect(resolved).toEqual({ token: "env-token", source: "env" });
    expect(loadAuthSession).not.toHaveBeenCalled();
  });

  it("falls back to the stored session token when no flag or env", async () => {
    (loadAuthSession as any).mockResolvedValue({ token: "session-token" });
    const resolved = await resolveHeadlessToken({ endpointUrl, env: {} });
    expect(resolved).toEqual({ token: "session-token", source: "session" });
    expect(loadAuthSession).toHaveBeenCalledWith(endpointUrl);
  });

  it("returns null when no credential is available anywhere", async () => {
    (loadAuthSession as any).mockResolvedValue(null);
    const resolved = await resolveHeadlessToken({ endpointUrl, env: {} });
    expect(resolved).toBeNull();
  });

  it("ignores blank flag/env values", async () => {
    (loadAuthSession as any).mockResolvedValue({ token: "session-token" });
    const resolved = await resolveHeadlessToken({
      flagToken: "   ",
      endpointUrl,
      env: { POPPI_TOKEN: "  " },
    });
    expect(resolved).toEqual({ token: "session-token", source: "session" });
  });
});

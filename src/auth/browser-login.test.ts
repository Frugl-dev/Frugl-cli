import { describe, it, expect } from "vitest";
import { startBrowserLogin, type BrowserLoginResult } from "./browser-login.js";

// Drive the loopback callback server exactly as the cloud's cli-callback
// redirect would: parse port + state out of the URL handed to the browser,
// then GET /callback with the minted-token query params.

interface Launched {
  promise: Promise<BrowserLoginResult>;
  port: number;
  state: string;
  oauthUrl: string;
}

async function launch(timeoutMs = 5_000): Promise<Launched> {
  let resolveUrl: (url: string) => void;
  const urlOpened = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const promise = startBrowserLogin({
    provider: "github",
    endpointUrl: "https://cloud.test",
    timeoutMs,
    openUrl: (url) => resolveUrl(url),
  });
  const oauthUrl = await urlOpened;
  const redirectTo = new URL(oauthUrl).searchParams.get("redirect_to")!;
  const params = new URLSearchParams(redirectTo.split("?")[1]);
  return {
    promise,
    port: Number(params.get("port")),
    state: params.get("state")!,
    oauthUrl,
  };
}

function callback(port: number, params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  return fetch(`http://127.0.0.1:${port}/callback?${qs}`);
}

describe("startBrowserLogin", () => {
  it("sends a high-entropy state nonce through the cli-callback redirect", async () => {
    const a = await launch();
    const b = await launch();
    expect(a.state.length).toBeGreaterThanOrEqual(32);
    expect(a.state).not.toBe(b.state); // fresh per invocation
    expect(a.oauthUrl).toContain(encodeURIComponent(`state=${a.state}`));
    // Clean up: complete both flows.
    await callback(a.port, { token: "t", email: "e@x.com", userId: "u", state: a.state });
    await callback(b.port, { token: "t", email: "e@x.com", userId: "u", state: b.state });
    await a.promise;
    await b.promise;
  });

  it("resolves with the token when the callback carries the matching state", async () => {
    const { promise, port, state } = await launch();
    const res = await callback(port, {
      token: "pat_secret",
      email: "dev@example.com",
      userId: "user-1",
      state,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You&rsquo;re in.");
    await expect(promise).resolves.toEqual({
      token: "pat_secret",
      email: "dev@example.com",
      userId: "user-1",
    });
  });

  it("rejects a forged callback (wrong state) without consuming the flow", async () => {
    const { promise, port, state } = await launch();

    // An attacker who guessed the port but not the nonce gets a 403 and the
    // injected token is never accepted…
    const forged = await callback(port, {
      token: "attacker_token",
      email: "attacker@evil.test",
      userId: "attacker",
      state: "wrong-state-wrong-state-wrong-state-wrong",
    });
    expect(forged.status).toBe(403);

    // …and a missing state is rejected the same way…
    const missing = await callback(port, { token: "x", email: "y@z", userId: "z" });
    expect(missing.status).toBe(403);

    // …while the legitimate callback still succeeds afterwards.
    const legit = await callback(port, {
      token: "real_token",
      email: "dev@example.com",
      userId: "user-1",
      state,
    });
    expect(legit.status).toBe(200);
    await expect(promise).resolves.toMatchObject({ token: "real_token" });
  });

  it("rejects (with an error page, not a success page) when fields are missing", async () => {
    const { promise, port, state } = await launch();
    // Attach the rejection handler before triggering the callback so the
    // rejection is never momentarily unhandled.
    const settled = promise.then(
      () => null,
      (err: unknown) => err,
    );
    const res = await callback(port, { email: "dev@example.com", state });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("You&rsquo;re in.");
    const err = await settled;
    expect(String(err)).toMatch(/missing required fields/);
  });

  it("times out when no callback ever arrives", async () => {
    const { promise } = await launch(100);
    await expect(promise).rejects.toThrow(/timed out/);
  });
});

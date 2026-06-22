import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../lib/exit-codes.js";
import { runCli } from "../../e2e/helpers/spawn.js";
import { clearAuth } from "../../e2e/helpers/auth.js";

// Spawn-based command tests for `snapshot context` and `snapshot mcp`.
//
// Both commands are auth=require: buildCommandContext requires a stored session
// BEFORE any capture/upload runs. The unauthenticated path is therefore the only
// branch that is fully deterministic from a spawned process — the success path
// would shell out to the real `claude -p "/context"` / `claude mcp list`
// binaries, whose output is non-deterministic, slow, and may not exist in CI, so
// it is intentionally NOT exercised here (see report). These tests pin the
// documented exit-10 contract ("10 not authenticated — run: frugl login") and
// guard against a regression where the AuthError escaped to oclif as a raw
// exit-1 stack trace.

// A port with (almost certainly) nothing listening — the auth check fails before
// any HTTP call, so no server is needed.
const ENDPOINT = "http://127.0.0.1:59895";

describe("frugl snapshot commands — unauthenticated contract", { timeout: 30_000 }, () => {
  beforeEach(() => {
    clearAuth(ENDPOINT);
  });

  afterEach(() => {
    clearAuth(ENDPOINT);
  });

  for (const sub of ["context", "mcp"] as const) {
    describe(`snapshot ${sub}`, () => {
      it("no stored session → exit 10 (AUTH_FAILURE) with a clean message", async () => {
        const { exitCode, stderr } = await runCli(["snapshot", sub, "--endpoint", ENDPOINT]);
        expect(exitCode).toBe(EXIT.AUTH_FAILURE);
        // Cleanly formatted via printFruglError, not a raw "AuthError: …" stack.
        expect(stderr).toMatch(/^frugl: .*not logged in/im);
        expect(stderr).not.toMatch(/at SessionStore\.require/);
        // Default format prints the exit-code footer.
        expect(stderr).toMatch(/Exit code 10/);
      });

      it("--format json with no stored session → exit 10, no stack trace", async () => {
        const { exitCode, stderr } = await runCli([
          "snapshot",
          sub,
          "--format",
          "json",
          "--endpoint",
          ENDPOINT,
        ]);
        expect(exitCode).toBe(EXIT.AUTH_FAILURE);
        expect(stderr).toMatch(/not logged in/i);
        expect(stderr).not.toMatch(/at SessionStore\.require/);
      });
    });
  }
});

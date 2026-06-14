import { describe, it, expect } from "vitest";
import { runCli } from "../../e2e/helpers/spawn.js";
import { EXIT } from "../../lib/exit-codes.js";

// These drive the spawned CLI (tsx bin/dev.js → dist commands), so the surface
// is exercised end-to-end. Both paths are pre-auth and never spawn `claude`:
// the upload guard fires before auth, and bare `snapshot` only prints guidance.
describe("snapshot topic + upload target split", () => {
  it("`frugl upload <target>` is rejected with a redirect to `frugl snapshot`", async () => {
    const { exitCode, stderr } = await runCli([
      "upload",
      "context",
      "--endpoint",
      "http://127.0.0.1:1",
    ]);
    expect(exitCode).toBe(EXIT.USAGE);
    expect(stderr).toMatch(/no longer takes targets/i);
    expect(stderr).toMatch(/frugl snapshot/);
  });

  it("bare `frugl snapshot` prints guidance and uploads nothing (no auth needed)", async () => {
    const { exitCode, stdout } = await runCli(["snapshot"]);
    expect(exitCode).toBe(EXIT.OK);
    expect(stdout).toMatch(/snapshot context/);
    expect(stdout).toMatch(/snapshot mcp/);
    expect(stdout).toMatch(/--all/);
  });

  it("`frugl snapshot --format json` emits the snapshot kinds", async () => {
    const { exitCode, stdout } = await runCli(["snapshot", "--format", "json"]);
    expect(exitCode).toBe(EXIT.OK);
    const parsed = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(parsed.command).toBe("snapshot");
    expect(parsed.kinds).toEqual(["context", "mcp"]);
  });
});

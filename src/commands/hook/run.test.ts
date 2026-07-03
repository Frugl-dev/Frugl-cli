import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, type TempDir } from "../../e2e/helpers/fixtures.js";
import { runCli } from "../../e2e/helpers/spawn.js";

// Drives `hook run` via the spawned CLI — the exact way an editor hook invokes
// it. A throwaway HOME isolates both the keychain fallback (no stored session
// for the fake endpoint) and the conf store (cooldown/blocked state), and the
// endpoint points at a closed localhost port so a spawned child upload dies
// instantly without reaching anything real.

const ENDPOINT = "http://127.0.0.1:9";

interface RunJson {
  command: string;
  ok: boolean;
  action: "spawned" | "skipped";
  reason?: string;
  endpoint: string;
}

describe("frugl hook run", { timeout: 30_000 }, () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it("exits 0 with no output when not logged in (fleet-safe no-op)", async () => {
    const { exitCode, stdout, stderr } = await runCli(["hook", "run"], {
      env: { HOME: home.dir, FRUGL_TOKEN: undefined, FRUGL_ENDPOINT: ENDPOINT },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("reports the not-logged-in skip in json mode", async () => {
    const { exitCode, stdout } = await runCli(["hook", "run", "--format", "json"], {
      env: { HOME: home.dir, FRUGL_TOKEN: undefined, FRUGL_ENDPOINT: ENDPOINT },
    });
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.trim()) as RunJson;
    expect(json).toMatchObject({
      command: "hook run",
      ok: true,
      action: "skipped",
      reason: "not_logged_in",
      endpoint: ENDPOINT,
    });
  });

  it("spawns when a token is available, then cools down on the next trigger", async () => {
    const env = { HOME: home.dir, FRUGL_TOKEN: "tok_test", FRUGL_ENDPOINT: ENDPOINT };

    const first = await runCli(["hook", "run", "--format", "json"], { env });
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout.trim()) as RunJson).toMatchObject({
      action: "spawned",
      endpoint: ENDPOINT,
    });

    const second = await runCli(["hook", "run", "--format", "json"], { env });
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.trim()) as RunJson).toMatchObject({
      action: "skipped",
      reason: "cooldown",
    });
  });

  it("tolerates a Codex notify JSON payload as a positional argument", async () => {
    const { exitCode } = await runCli(
      ["hook", "run", '{"type":"agent-turn-complete","turn-id":"t1"}'],
      { env: { HOME: home.dir, FRUGL_TOKEN: undefined, FRUGL_ENDPOINT: ENDPOINT } },
    );
    expect(exitCode).toBe(0);
  });
});

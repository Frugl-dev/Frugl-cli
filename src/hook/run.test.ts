import { describe, it, expect, afterEach } from "vitest";
import { Temporal } from "temporal-polyfill";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../auth/session-store.js";
import { createInMemoryCredentialStore } from "../auth/credential-store.js";
import { DEFAULT_ENDPOINT } from "../cloud/endpoints.js";
import { getLastHookSpawn, recordUploadBlocked } from "../lib/config.js";
import { nowIso } from "../lib/time.js";
import { executeHookRun, HOOK_SPAWN_COOLDOWN_MS } from "./run.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "frugl-hookrun-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// Every test gets an isolated conf store (configOptions.cwd), an empty or
// seeded in-memory credential store, and a spawn spy — nothing touches the real
// keychain, config, or process table.
function makeDeps(overrides: { token?: string; env?: NodeJS.ProcessEnv } = {}) {
  const configDir = makeTmp();
  const cwd = makeTmp();
  const env: NodeJS.ProcessEnv = overrides.env ?? {};
  if (overrides.token !== undefined) env["FRUGL_TOKEN"] = overrides.token;
  const spawned: string[] = [];
  return {
    configDir,
    cwd,
    spawned,
    deps: {
      env,
      cwd,
      store: new SessionStore({ store: createInMemoryCredentialStore(), env }),
      configOptions: { cwd: configDir },
      spawnUpload: (endpointUrl: string) => spawned.push(endpointUrl),
    },
  };
}

const afterCooldown = () =>
  Temporal.Now.instant().add({ milliseconds: HOOK_SPAWN_COOLDOWN_MS + 1000 });
const afterBlockTtl = () => Temporal.Now.instant().add({ hours: 13 });

describe("executeHookRun", () => {
  it("silently no-ops when not logged in — no spawn, no state written", async () => {
    const { deps, spawned, configDir } = makeDeps();
    const result = await executeHookRun(deps);
    expect(result).toEqual({
      action: "skipped",
      reason: "not_logged_in",
      endpoint: DEFAULT_ENDPOINT,
    });
    expect(spawned).toEqual([]);
    // No cooldown stamp either — a never-onboarded machine stays untouched.
    expect(getLastHookSpawn({ cwd: configDir })).toBeUndefined();
  });

  it("spawns a detached upload when a token is available and stamps the cooldown", async () => {
    const { deps, spawned, configDir } = makeDeps({ token: "tok_test" });
    const result = await executeHookRun(deps);
    expect(result).toEqual({ action: "spawned", endpoint: DEFAULT_ENDPOINT });
    expect(spawned).toEqual([DEFAULT_ENDPOINT]);
    expect(getLastHookSpawn({ cwd: configDir })?.endpoint).toBe(DEFAULT_ENDPOINT);
  });

  it("skips within the cooldown window, then spawns again after it", async () => {
    const { deps, spawned } = makeDeps({ token: "tok_test" });
    await executeHookRun(deps);
    const second = await executeHookRun(deps);
    expect(second).toMatchObject({ action: "skipped", reason: "cooldown" });
    expect(spawned).toHaveLength(1);

    const third = await executeHookRun({ ...deps, now: afterCooldown });
    expect(third).toMatchObject({ action: "spawned" });
    expect(spawned).toHaveLength(2);
  });

  it("honors a cached org-blocked verdict until it expires", async () => {
    const { deps, spawned, configDir } = makeDeps({ token: "tok_test" });
    recordUploadBlocked(DEFAULT_ENDPOINT, { cwd: configDir });
    const blocked = await executeHookRun(deps);
    expect(blocked).toMatchObject({ action: "skipped", reason: "blocked" });
    expect(spawned).toEqual([]);

    // Past the TTL the verdict is stale and the upload re-checks the server.
    const retried = await executeHookRun({ ...deps, now: afterBlockTtl });
    expect(retried).toMatchObject({ action: "spawned" });
  });

  it("ignores a blocked verdict recorded against a different endpoint", async () => {
    const { deps, spawned, configDir } = makeDeps({ token: "tok_test" });
    recordUploadBlocked("https://other.example.com", { cwd: configDir });
    const result = await executeHookRun(deps);
    expect(result).toMatchObject({ action: "spawned" });
    expect(spawned).toEqual([DEFAULT_ENDPOINT]);
  });

  it("routes via a .frugl.json endpoint pin — the spawned upload gets the pinned URL", async () => {
    const { deps, spawned, cwd } = makeDeps({ token: "tok_test" });
    writeFileSync(
      path.join(cwd, ".frugl.json"),
      JSON.stringify({ version: 1, endpoint: "https://frugl.internal.example" }),
    );
    const result = await executeHookRun(deps);
    expect(result).toEqual({ action: "spawned", endpoint: "https://frugl.internal.example" });
    expect(spawned).toEqual(["https://frugl.internal.example"]);
  });

  it("uses a stored keychain session when no env token exists", async () => {
    const configDir = makeTmp();
    const cwd = makeTmp();
    const session = {
      email: "dev@example.com",
      userId: "user-1",
      token: "tok_session",
      endpointUrl: DEFAULT_ENDPOINT,
      loggedInAt: nowIso(),
    };
    const store = new SessionStore({
      store: createInMemoryCredentialStore({ [DEFAULT_ENDPOINT]: JSON.stringify(session) }),
      env: {},
    });
    const spawned: string[] = [];
    const result = await executeHookRun({
      env: {},
      cwd,
      store,
      configOptions: { cwd: configDir },
      spawnUpload: (url) => spawned.push(url),
    });
    expect(result).toMatchObject({ action: "spawned" });
    expect(spawned).toEqual([DEFAULT_ENDPOINT]);
  });
});

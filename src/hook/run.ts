import { spawn } from "node:child_process";
import { SessionStore } from "../auth/session-store.js";
import { resolveEndpoint, safeEndpoint } from "../cloud/endpoints.js";
import { loadProjectPin } from "../cloud/project-pin.js";
import {
  getLastHookSpawn,
  getSavedEndpoint,
  getUploadBlocked,
  recordLastHookSpawn,
  type ConfigStoreOptions,
} from "../lib/config.js";

// The core of `frugl hook run` — the command every editor/CLI session hook
// invokes. It must be FAST and must never poison the calling hook, so it always
// exits 0 on the expected non-upload states and detaches the real upload:
//
//   1. Not logged in → silent no-op. This is what makes fleet-wide hook
//      rollout safe with partial licensing: an unlicensed user who never ran
//      `frugl login` pays one process spawn and nothing else — no discovery, no
//      network, and deliberately NO pendingAuthFailure breadcrumb (that nag is
//      for a token that DIED, not a user who was never onboarded).
//   2. Org blocked (cached, TTL'd) → no-op until the verdict expires.
//   3. Cooldown → no-op when an upload was spawned moments ago (Codex's notify
//      fires per turn; one sweep covers everything pending anyway).
//   4. Otherwise → spawn `frugl upload` detached and exit immediately, so even
//      synchronous hook runners (Gemini blocks CLI exit on SessionEnd) never
//      make the user wait on a network call.
//
// The resolved endpoint (including a `.frugl.json` self-host pin — hooks run
// with cwd inside the project) is passed to the child as an explicit
// --endpoint, so the spawned upload cannot re-resolve differently.

export const HOOK_SPAWN_COOLDOWN_MS = 2 * 60 * 1000;

export type HookRunResult =
  | { action: "spawned"; endpoint: string }
  | { action: "skipped"; reason: "not_logged_in" | "blocked" | "cooldown"; endpoint: string };

export interface HookRunDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  flagEndpoint?: string | undefined;
  store?: SessionStore;
  configOptions?: ConfigStoreOptions;
  spawnUpload?: (endpointUrl: string) => void;
  now?: () => Date;
}

export async function executeHookRun(deps: HookRunDeps = {}): Promise<HookRunResult> {
  const env = deps.env ?? process.env;
  const configOptions = deps.configOptions ?? {};
  const now = deps.now ?? (() => new Date());

  // Fail-closed like every other command: a present-but-malformed pin throws
  // rather than letting a self-host repo fall through to the public cloud.
  const pin = loadProjectPin(deps.cwd);
  const endpoint = resolveEndpoint({
    flag: deps.flagEndpoint,
    pinned: pin?.endpoint,
    env: env["FRUGL_ENDPOINT"],
    saved: safeEndpoint(readSavedEndpoint(configOptions)),
  });

  const store = deps.store ?? new SessionStore({ env });
  const token = await resolveTokenSafe(store, endpoint.url);
  if (token === null) {
    return { action: "skipped", reason: "not_logged_in", endpoint: endpoint.url };
  }

  const blocked = readSafe(() => getUploadBlocked(configOptions));
  if (blocked?.endpoint === endpoint.url && Date.parse(blocked.until) > now().getTime()) {
    return { action: "skipped", reason: "blocked", endpoint: endpoint.url };
  }

  const lastSpawn = readSafe(() => getLastHookSpawn(configOptions));
  if (lastSpawn?.endpoint === endpoint.url) {
    const elapsed = now().getTime() - Date.parse(lastSpawn.at);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < HOOK_SPAWN_COOLDOWN_MS) {
      return { action: "skipped", reason: "cooldown", endpoint: endpoint.url };
    }
  }

  // Stamp BEFORE spawning: two hooks firing together should collapse to one
  // sweep, and a stamp-then-crash costs nothing (the next trigger uploads it all).
  try {
    recordLastHookSpawn(endpoint.url, now(), configOptions);
  } catch {
    /* best-effort — a config glitch must not stop the upload */
  }
  (deps.spawnUpload ?? spawnDetachedUpload)(endpoint.url);
  return { action: "spawned", endpoint: endpoint.url };
}

// Re-invoke this same CLI entrypoint detached. The child owns the slow work
// (discovery, anonymization, network) and its own failure reporting (breadcrumb
// on AuthError, blocked cache on OrgBlockedError); nothing is attached to the
// hook's lifetime.
function spawnDetachedUpload(endpointUrl: string): void {
  const entry = process.argv[1];
  if (!entry) return;
  const child = spawn(
    process.execPath,
    [entry, "upload", "sessions", "--yes", "--format", "json", "--endpoint", endpointUrl],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

// A keychain/store hiccup in a background hook must degrade to "not logged in"
// (silent no-op), never to a crash the hook runner surfaces to the user.
async function resolveTokenSafe(store: SessionStore, endpointUrl: string) {
  try {
    return await store.resolveToken({ endpointUrl });
  } catch {
    return null;
  }
}

function readSavedEndpoint(options: ConfigStoreOptions): string | undefined {
  return readSafe(() => getSavedEndpoint(options));
}

function readSafe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

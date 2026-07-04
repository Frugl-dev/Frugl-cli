import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { safeEndpoint } from "./endpoints.js";
import { EndpointError } from "../lib/errors.js";

// A checked-in, repo-local endpoint pin. Unlike `saved` (an explicit per-user
// login choice) this IS an ambient read of the cwd — deliberately so, for the
// self-host case: a company drops `.frugl.json` at its repo root and every
// clone targets the internal Frugl instead of the public cloud. The hijack risk
// of trusting cwd config (a malicious repo redirecting uploads) is contained two
// ways: the pin can only RESTRICT — it overrides the ambient env/saved/default
// layers but loses to a hand-typed --endpoint, and never falls back to the
// public default (precedence lives in cloud/endpoints.ts) — and auth is
// endpoint-scoped, so uploading to a pinned endpoint you've never logged into
// fails with AuthError rather than silently shipping a token, keeping adoption
// of a new endpoint a consensual `frugl login`.
export const PROJECT_PIN_FILENAME = ".frugl.json";

export interface ProjectPin {
  /** The pinned endpoint, already validated + normalized. */
  endpoint: string;
  /** Absolute path to the `.frugl.json` that declared it (for messages). */
  path: string;
}

// Walk up from `startDir` to the filesystem root, returning the first
// `.frugl.json` found, or undefined if none exists.
function findPinFile(startDir: string): string | undefined {
  let dir = startDir;
  const { root } = parsePath(dir);
  for (;;) {
    const candidate = join(dir, PROJECT_PIN_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Load the checked-in project endpoint pin, if any. FAIL-CLOSED: a present but
// malformed `.frugl.json` THROWS (EndpointError) rather than being ignored — a
// self-hosting repo must never silently fall through to the public cloud
// because its pin file had a typo. A file with no `endpoint` key is treated as
// "no pin" (the file may carry other future config), not an error.
export function loadProjectPin(startDir: string = process.cwd()): ProjectPin | undefined {
  const file = findPinFile(startDir);
  if (file === undefined) return undefined;
  return parsePinFile(file);
}

// Environment variable naming an explicit config file to read the endpoint from,
// bypassing the cwd walk. A local-debugging convenience: keep e.g.
// `~/frugl/local.json` and `~/frugl/prod.json` around and flip between them by
// exporting this, without editing any checked-in `.frugl.json` or retyping
// --endpoint on every command. Sits ABOVE the cwd pin in precedence (see
// cloud/endpoints.ts) because pointing at a file by name is a deliberate act.
export const CONFIG_PATH_ENV = "FRUGL_CONFIG_PATH";

// Load the endpoint pin from the file named by `FRUGL_CONFIG_PATH`, if that env
// is set. FAIL-CLOSED like `loadProjectPin`: once you've explicitly named a file
// a missing/unreadable/malformed one THROWS rather than silently falling through
// to the cwd pin or the public cloud — the whole point was to target that file.
// A leading `~/` is expanded so an unquoted shell path and a quoted one behave
// the same. Returns undefined only when the env is unset (or empty).
export function loadConfigPathPin(
  env: string | undefined = process.env[CONFIG_PATH_ENV],
): ProjectPin | undefined {
  if (env === undefined || env.trim() === "") return undefined;
  const file = resolveConfigPath(env.trim());
  if (!existsSync(file)) {
    throw new EndpointError(`${CONFIG_PATH_ENV} points at ${file}, which does not exist.`);
  }
  return parsePinFile(file);
}

// Expand a leading `~` / `~/` to the home dir, then make absolute (relative to
// cwd) so downstream error messages show a real, actionable path.
function resolveConfigPath(raw: string): string {
  let expanded = raw;
  if (raw === "~") {
    expanded = homedir();
  } else if (raw.startsWith("~/")) {
    expanded = join(homedir(), raw.slice(2));
  }
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

// Read + parse + validate one endpoint-pin file. Shared by the cwd walk and the
// explicit `FRUGL_CONFIG_PATH` path so both apply the identical fail-closed
// rules. A file with no `endpoint` key is "no pin" (undefined), not an error —
// the file may carry other/future config.
function parsePinFile(file: string): ProjectPin | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new EndpointError(`Could not read ${file}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EndpointError(
      `${file} is not valid JSON. Fix or remove it — a self-hosted endpoint pin must be explicit.`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EndpointError(
      `${file} must be a JSON object like { "endpoint": "https://frugl.internal" }.`,
    );
  }

  const endpoint = (parsed as Record<string, unknown>)["endpoint"];
  if (endpoint === undefined) return undefined;
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new EndpointError(`${file} has an invalid "endpoint" — expected a non-empty URL string.`);
  }

  // Validate at load (not downstream) so a malformed pin fails closed even when
  // an explicit --endpoint flag would otherwise short-circuit resolution — a
  // self-host repo must never quietly fall through to the public cloud.
  const normalized = safeEndpoint(endpoint.trim());
  if (normalized === undefined) {
    throw new EndpointError(
      `${file} has an invalid "endpoint" (${endpoint.trim()}) — must be https (or http on localhost).`,
    );
  }

  return { endpoint: normalized, path: file };
}

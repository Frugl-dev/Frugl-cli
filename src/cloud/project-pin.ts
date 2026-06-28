import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
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

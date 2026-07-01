import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { z } from "zod";
import { DEFAULT_ENDPOINT } from "../cloud/endpoints.js";
import { UsageError } from "../lib/errors.js";

// The single, committable, project-level config file (spec 007). It subsumes
// the two project files that existed before it: the self-host endpoint pin
// (`.frugl.json` with only `{ endpoint }`, still read raw by cloud/project-pin.ts
// for the eager pre-auth path) and the upload-scope config (`frugl.config.json`,
// now a deprecated fallback). This module is the ONE reader/writer for the
// typed config surface; project-pin.ts deliberately stays a separate, minimal
// `endpoint`-only reader so endpoint resolution never depends on the full schema.
export const PROJECT_CONFIG_FILENAME = ".frugl.json";

// Editor autocomplete + validation target. Written verbatim on every save so a
// hand-edited file gains schema help the next time `init` touches it. The doc
// itself is hosted separately (out of scope here); the URL is stable.
const SCHEMA_URL = "https://app.frugl.dev/schema/frugl.v1.json";

// Built-in defaults for the managed `upload.*` keys. A written value equal to
// its default is omitted (keeps the file small and "what did I customize"
// obvious — spec § conventions). MIN_COST mirrors upload's MIN_COST_FLOOR_USD;
// it is duplicated here on purpose rather than imported, because importing from
// commands/upload.ts (which imports upload-config.ts, which imports this module)
// would close an import cycle and drag the whole command graph into config.
const DEFAULT_MIN_COST_USD = 10;
const DEFAULT_SNAPSHOT = true;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LINK_PRS = false;

const objectStrict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// `.strict()` so a typo (e.g. `uplaod`) fails closed rather than being silently
// ignored — the same posture as upload-config.ts. `$schema` and `version` are
// allowed (and `version` is required in a real config); everything else is the
// grouped-by-concern shape from the spec's file contract.
export const projectConfigSchema = objectStrict({
  $schema: z.string().optional(),
  version: z.literal(1),
  endpoint: z.url().optional(),
  org: z.string().min(1).optional(),
  upload: objectStrict({
    // Set to false to disable upload for this repo (frugl upload exits immediately).
    enabled: z.boolean().optional(),
    // When true, skips the confirmation prompt and auto-runs snapshot after
    // upload — equivalent to always passing --yes. Commit this in repos where
    // non-interactive use (CI, hooks) is the norm.
    auto: z.boolean().optional(),
    minCost: z.number().positive().optional(),
    snapshot: z.boolean().optional(),
    concurrency: z.number().int().positive().optional(),
    linkPrs: z.boolean().optional(),
    providers: z.array(z.string().min(1)).optional(),
    projects: objectStrict({
      include: z.array(z.string().min(1)).optional(),
      exclude: z.array(z.string().min(1)).optional(),
    }).optional(),
  }).optional(),
  snapshot: objectStrict({
    // Set to false to disable snapshot for this repo (frugl snapshot exits immediately
    // and snapshot is skipped when upload.auto is true).
    enabled: z.boolean().optional(),
  }).optional(),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

// Walk from `startDir` up to (and including) `home`, then to the filesystem
// root, returning the first `.frugl.json` found — same pattern as
// upload-config.ts / project-pin.ts so all three agree on discovery.
function findNearest(startDir: string, home: string): string | null {
  let dir = startDir;
  const { root } = parsePath(dir);
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === home || dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Read + JSON-parse a single `.frugl.json` WITHOUT schema validation. Used as
// the merge base by `writeProjectConfig` (so an `init` re-run can upgrade a
// legacy/partial file and preserve unknown keys verbatim) and for the command's
// conflict detection. FAIL-CLOSED on broken JSON or a non-object — we never
// silently drop a file we couldn't understand. Missing file → null.
export function readMergeableConfig(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new UsageError(
      `Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${filePath} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

// Load and validate the nearest `.frugl.json`, walking cwd → git-root/$HOME.
// `FRUGL_CONFIG` overrides discovery with an explicit path. FAIL-CLOSED
// (FR-011): present-but-malformed JSON or a schema violation THROWS UsageError
// — a config consumer must never quietly fall through to "no config". A truly
// empty object (`{}`) is treated as "no config" (null); a file with keys but no
// `version: 1` is a clear schema error, not silently tolerated. The ONE
// exception is the legacy endpoint-only pin (`{ endpoint }`, no `version`),
// which predates the v1 schema and is tolerated as null (see below).
export function readProjectConfig(
  startDir: string = process.cwd(),
  home: string = homedir(),
): ProjectConfig | null {
  let file: string | null;
  const override = process.env["FRUGL_CONFIG"]?.trim();
  if (override) {
    if (!existsSync(override)) throw new UsageError(`FRUGL_CONFIG file not found: ${override}`);
    file = override;
  } else {
    file = findNearest(startDir, home);
  }
  if (file === null) return null;

  const parsed = readMergeableConfig(file);
  if (parsed === null) return null;
  const keys = Object.keys(parsed);
  // An otherwise-empty file carries no config — tolerate it as "absent" rather
  // than demanding a `version` key for a file that says nothing.
  if (keys.length === 0) return null;

  // Legacy self-host endpoint pin: a pre-v1 `.frugl.json` whose ONLY key is
  // `endpoint` (the bare pin shape that cloud/project-pin.ts still reads for the
  // eager endpoint resolution path) is NOT a typed v1 project config. Tolerate
  // it as "no project config" (null) so `loadUploadConfig` falls through rather
  // than throwing — otherwise existing self-host repos that pin only an endpoint
  // would break `frugl upload`. Fail-closed everywhere else: anything that
  // declares `version`, or carries other (config-ish or unknown) keys without a
  // valid `version: 1`, is treated as a real config and validated below.
  if (!("version" in parsed) && keys.every((k) => k === "endpoint")) return null;

  const result = projectConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue?.path.join(".") || "<root>";
    throw new UsageError(`Invalid ${file}: ${at} — ${issue?.message ?? "schema error"}`);
  }
  return result.data;
}

const MANAGED_TOP = new Set(["$schema", "version", "endpoint", "org", "upload", "snapshot"]);
const MANAGED_UPLOAD = new Set([
  "enabled",
  "auto",
  "minCost",
  "snapshot",
  "concurrency",
  "linkPrs",
  "providers",
  "projects",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Deep-merge the `upload` block (patch over base), one level into `projects` so
// a patch that sets only `upload.minCost` keeps an existing `upload.projects`.
function mergeUpload(base: unknown, patch: unknown): Record<string, unknown> | undefined {
  const b = isPlainObject(base) ? base : undefined;
  const p = isPlainObject(patch) ? patch : undefined;
  if (!b && !p) return undefined;
  const merged: Record<string, unknown> = { ...b, ...p };
  const bp = b?.["projects"];
  const pp = p?.["projects"];
  if (isPlainObject(bp) || isPlainObject(pp)) {
    merged["projects"] = {
      ...(isPlainObject(bp) ? bp : {}),
      ...(isPlainObject(pp) ? pp : {}),
    };
  }
  return merged;
}

// Strip non-empty `projects` to include/exclude in fixed order, dropping empty
// arrays. Returns undefined when nothing meaningful remains (so it is omitted).
function cleanProjects(projects: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(projects)) return undefined;
  const out: Record<string, unknown> = {};
  const include = projects["include"];
  const exclude = projects["exclude"];
  if (Array.isArray(include) && include.length > 0) out["include"] = include;
  if (Array.isArray(exclude) && exclude.length > 0) out["exclude"] = exclude;
  // Preserve any unknown projects.* keys verbatim (forward-compat).
  for (const [k, v] of Object.entries(projects)) {
    if (k === "include" || k === "exclude") continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Build the cleaned `snapshot` block: only `enabled: false` is written (true is
// the default and omitted). Unknown keys preserved. Returns undefined when empty.
function cleanSnapshot(snapshot: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(snapshot)) return undefined;
  const out: Record<string, unknown> = {};
  if (snapshot["enabled"] === false) out["enabled"] = false;
  for (const [k, v] of Object.entries(snapshot)) {
    if (k === "enabled") continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Build the cleaned, fixed-order `upload` block: managed keys equal to their
// default are omitted, unknown keys preserved. Returns undefined when empty.
function cleanUpload(upload: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(upload)) return undefined;
  const out: Record<string, unknown> = {};
  if (upload["enabled"] === false) out["enabled"] = false;
  if (upload["auto"] === true) out["auto"] = true;
  if (typeof upload["minCost"] === "number" && upload["minCost"] !== DEFAULT_MIN_COST_USD) {
    out["minCost"] = upload["minCost"];
  }
  if (typeof upload["snapshot"] === "boolean" && upload["snapshot"] !== DEFAULT_SNAPSHOT) {
    out["snapshot"] = upload["snapshot"];
  }
  if (typeof upload["concurrency"] === "number" && upload["concurrency"] !== DEFAULT_CONCURRENCY) {
    out["concurrency"] = upload["concurrency"];
  }
  if (typeof upload["linkPrs"] === "boolean" && upload["linkPrs"] !== DEFAULT_LINK_PRS) {
    out["linkPrs"] = upload["linkPrs"];
  }
  if (Array.isArray(upload["providers"]) && upload["providers"].length > 0) {
    out["providers"] = upload["providers"];
  }
  const projects = cleanProjects(upload["projects"]);
  if (projects !== undefined) out["projects"] = projects;
  // Preserve unknown upload.* keys verbatim (a newer CLI's future field).
  for (const [k, v] of Object.entries(upload)) {
    if (MANAGED_UPLOAD.has(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Serialize the merged config with a FIXED key order ($schema, version,
// endpoint, org, upload), managed defaults omitted, unknown keys appended
// verbatim, two-space indent, trailing newline. The fixed shape is what makes a
// re-run byte-stable (FR-008) and keeps diffs meaningful.
function serialize(merged: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  out["$schema"] = SCHEMA_URL;
  out["version"] = 1;
  // Never pin the public default into a committable file (FR-007): an endpoint
  // equal to the built-in default is omitted, so a cloud user is never locked
  // to a stale endpoint by a checked-in config.
  const endpoint = merged["endpoint"];
  if (typeof endpoint === "string" && endpoint !== "" && endpoint !== DEFAULT_ENDPOINT) {
    out["endpoint"] = endpoint;
  }
  const org = merged["org"];
  if (typeof org === "string" && org !== "") out["org"] = org;
  const upload = cleanUpload(merged["upload"]);
  if (upload !== undefined) out["upload"] = upload;
  const snapshot = cleanSnapshot(merged["snapshot"]);
  if (snapshot !== undefined) out["snapshot"] = snapshot;
  // Unmanaged top-level keys preserved verbatim, after the managed ones.
  for (const [k, v] of Object.entries(merged)) {
    if (MANAGED_TOP.has(k)) continue;
    out[k] = v;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export interface WriteProjectConfigOptions {
  /** Directory to write `.frugl.json` into; defaults to the cwd. */
  dir?: string;
  /** Reserved for the caller's overwrite policy; merge logic ignores it. */
  force?: boolean;
}

// Merge `patch` over any existing `.frugl.json` at `dir` and write the result.
// Always stamps `$schema` + `version: 1`, omits managed keys equal to their
// default, preserves unknown keys, and serializes in fixed key order. Returns
// `changed: false` (and skips the write) when the serialized output is
// byte-identical to what's on disk — so a no-op re-run never churns the file or
// its mtime. This function does NOT prompt or refuse on a conflicting value:
// detecting and confirming a conflict is the command's job (FR-009).
export function writeProjectConfig(
  patch: Partial<ProjectConfig>,
  opts: WriteProjectConfigOptions = {},
): { path: string; changed: boolean } {
  const dir = opts.dir ?? process.cwd();
  const filePath = join(dir, PROJECT_CONFIG_FILENAME);

  const base = readMergeableConfig(filePath) ?? {};
  const merged: Record<string, unknown> = { ...base };
  if (patch.endpoint !== undefined) merged["endpoint"] = patch.endpoint;
  if (patch.org !== undefined) merged["org"] = patch.org;
  const upload = mergeUpload(base["upload"], patch.upload);
  if (upload !== undefined) merged["upload"] = upload;
  if (patch.snapshot !== undefined)
    merged["snapshot"] = { ...(base["snapshot"] as object), ...patch.snapshot };

  const next = serialize(merged);
  const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  if (current === next) return { path: filePath, changed: false };

  writeFileSync(filePath, next, "utf8");
  return { path: filePath, changed: true };
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import { UsageError } from "../lib/errors.js";
import { findProjectConfigDir, readProjectConfig, type ProjectConfig } from "./project-config.js";
import type { DetectedProvider, ProjectGroup } from "../sources/providers.js";
import type { Selection } from "../select/selection.js";

export const UPLOAD_CONFIG_FILENAME = "frugl.config.json";

const objectStrict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const uploadConfigSchema = objectStrict({
  schemaVersion: z.literal(1),
  providers: z.array(z.string().min(1)).optional(),
  projects: objectStrict({
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  }).optional(),
  upload: objectStrict({
    enabled: z.boolean().optional(),
    auto: z.boolean().optional(),
    concurrency: z.number().int().positive().optional(),
    linkPrs: z.boolean().optional(),
    org: z.string().min(1).optional(),
  }).optional(),
  snapshot: objectStrict({
    enabled: z.boolean().optional(),
  }).optional(),
});

export type UploadConfig = z.infer<typeof uploadConfigSchema>;

export interface LoadConfigOptions {
  /** Explicit --config path. */
  explicitPath?: string | undefined;
  cwd?: string;
  home?: string;
}

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

// Walks from cwd up to (and including) home looking for frugl.config.json.
function findNearestConfig(cwd: string, home: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, UPLOAD_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

// Project the `.frugl.json` upload block onto the `UploadConfig` shape the
// upload command already consumes. Returns null only when there's no real v1
// `.frugl.json` at all (the caller then falls back to the deprecated
// frugl.config.json). A `.frugl.json` with no `upload` block still returns a
// (mostly empty) UploadConfig: the file's mere presence in a directory is what
// scopes discovery there (see loadUploadConfigScope) — an absent `upload` block
// just means every managed toggle keeps its default. The top-level `org` is
// carried into `upload.org` (the canonical file keeps `org` at the root, but
// `UploadConfig` groups it under `upload`). `minCost` has no slot in
// `UploadConfig` (the command reads `--min-cost` from its flag), so it's
// intentionally dropped here.
function uploadConfigFromProject(config: ProjectConfig | null): UploadConfig | null {
  if (!config) return null;
  const up = config.upload ?? {};

  const uploadBlock: NonNullable<UploadConfig["upload"]> = {
    ...(up.enabled === false ? { enabled: false } : {}),
    ...(up.auto ? { auto: up.auto } : {}),
    ...(up.concurrency !== undefined ? { concurrency: up.concurrency } : {}),
    ...(up.linkPrs !== undefined ? { linkPrs: up.linkPrs } : {}),
    ...(config.org !== undefined ? { org: config.org } : {}),
  };

  return {
    schemaVersion: 1,
    ...(up.providers ? { providers: up.providers } : {}),
    ...(Object.keys(uploadBlock).length > 0 ? { upload: uploadBlock } : {}),
    ...(config.snapshot ? { snapshot: config.snapshot } : {}),
  };
}

// Fail-closed: an explicit --config that can't be read, malformed JSON, or a
// schema violation all throw — the run uploads nothing rather than silently
// falling back to "everything" (FR-027). A missing file with no --config
// returns null so the caller uses its default scope (FR-003).
export function loadUploadConfig(opts: LoadConfigOptions = {}): UploadConfig | null {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  // `.frugl.json` is the canonical project config (spec 007); ANY real v1
  // `.frugl.json` takes precedence over the deprecated `frugl.config.json` —
  // its mere presence declares this directory a Frugl project (see
  // loadUploadConfigScope), even with no `upload` block at all. We only
  // consult it when no explicit `--config` path was given — `--config` is an
  // intentional, visible override that still points at a frugl.config.json.
  // Reading `.frugl.json` is fail-closed: a malformed file throws here (exit 2)
  // rather than silently falling through to the deprecated file or "upload everything".
  if (!opts.explicitPath) {
    const projectConfig = readProjectConfig(cwd, home);
    const fromProject = uploadConfigFromProject(projectConfig);
    if (fromProject) return fromProject;
    // Else: no `.frugl.json` at all (or a legacy endpoint-only pin) — fall
    // through to the deprecated frugl.config.json discovery below.
  }

  let found: string;
  if (opts.explicitPath) {
    found = path.resolve(opts.explicitPath);
    if (!existsSync(found)) throw new UsageError(`Config file not found: ${found}`);
  } else {
    const nearest = findNearestConfig(cwd, home);
    if (!nearest) return null;
    found = nearest;
  }

  let raw: string;
  try {
    raw = readFileSync(found, "utf8");
  } catch (err) {
    throw new UsageError(
      `Cannot read config file ${found}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `Invalid JSON in ${found}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = uploadConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue?.path.join(".") || "<root>";
    throw new UsageError(`Invalid config in ${found}: ${at} — ${issue?.message ?? "schema error"}`);
  }
  return result.data;
}

// The directory a `.frugl.json`-sourced UploadConfig scopes discovery to, or
// null when there's no such file (the caller should then fall back to the
// deprecated frugl.config.json's projects.include/exclude globs via
// resolveConfigSelection). Kept separate from loadUploadConfig's return value
// so its many existing callers/tests don't need to unwrap a wrapper object —
// callers that care about scope call both with the same opts.
export function loadUploadConfigScope(opts: LoadConfigOptions = {}): string | null {
  if (opts.explicitPath) return null;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  return readProjectConfig(cwd, home) ? findProjectConfigDir(cwd, home) : null;
}

// Computes the upload Selection from a config: providers ∩ supported-detected,
// and projects matched by include globs minus exclude globs (exclude wins).
// Absent providers/projects mean "all supported / all projects". Used ONLY for
// the deprecated frugl.config.json fallback — a `.frugl.json`-sourced config is
// always scoped by directory instead (see loadUploadConfigScope).
export function resolveConfigSelection(
  config: UploadConfig,
  detected: DetectedProvider[],
  groups: ProjectGroup[],
  home: string = homedir(),
): Selection {
  const supportedIds = detected.filter((d) => d.descriptor.supported).map((d) => d.descriptor.id);
  const providerIds = config.providers
    ? supportedIds.filter((id) => config.providers!.includes(id))
    : supportedIds;

  const include = config.projects?.include;
  const exclude = config.projects?.exclude;
  const isIncluded =
    include && include.length > 0 ? picomatch(include.map((p) => expandTilde(p, home))) : null;
  const isExcluded =
    exclude && exclude.length > 0 ? picomatch(exclude.map((p) => expandTilde(p, home))) : null;

  const providerSet = new Set(providerIds);
  const projectIds = groups
    .filter((g) => providerSet.has(g.providerId))
    .filter((g) => {
      const p = expandTilde(g.displayName, home);
      if (isIncluded && !isIncluded(p)) return false;
      if (isExcluded && isExcluded(p)) return false;
      return true;
    })
    .map((g) => g.projectId);

  return { providerIds, projectIds };
}

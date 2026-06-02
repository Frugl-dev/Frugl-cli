import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import { UsageError } from "../lib/errors.js";
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
    concurrency: z.number().int().positive().optional(),
    linkPrs: z.boolean().optional(),
    org: z.string().min(1).optional(),
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

// Fail-closed: an explicit --config that can't be read, malformed JSON, or a
// schema violation all throw — the run uploads nothing rather than silently
// falling back to "everything" (FR-027). A missing file with no --config
// returns null so the caller uses its default scope (FR-003).
export function loadUploadConfig(opts: LoadConfigOptions = {}): UploadConfig | null {
  const home = opts.home ?? homedir();
  let found: string;
  if (opts.explicitPath) {
    found = path.resolve(opts.explicitPath);
    if (!existsSync(found)) throw new UsageError(`Config file not found: ${found}`);
  } else {
    const nearest = findNearestConfig(opts.cwd ?? process.cwd(), home);
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

// Computes the upload Selection from a config: providers ∩ supported-detected,
// and projects matched by include globs minus exclude globs (exclude wins).
// Absent providers/projects mean "all supported / all projects".
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

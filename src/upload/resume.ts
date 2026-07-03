import Conf from "conf";
import { z } from "zod";
import { NAMESPACES } from "../lib/paths.js";
import { FAILURE_REASONS } from "./failure-reasons.js";

const RESUME_SCHEMA_VERSION = 1 as const;

export const manifestEntryStatusSchema = z.enum([
  "pending",
  "in-flight",
  "acked",
  "skipped-on-resume",
]);
export type ManifestEntryStatus = z.infer<typeof manifestEntryStatusSchema>;

export const manifestEntrySchema = z.object({
  sessionId: z.string(),
  identityDerivation: z.enum(["native", "path-hash"]),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().min(0),
  sourceFilePath: z.string(),
  rawContentHashAtFirstRun: z.string().regex(/^[a-f0-9]{64}$/),
  status: manifestEntryStatusSchema,
  ackedAt: z.string().datetime().optional(),
  skippedReason: z.enum(["missing", "modified"]).optional(),
  // The last per-session upload failure, retained across the reset-to-pending so
  // `frugl upload --report` can explain what failed and why. Cleared on ack.
  lastFailureReason: z.enum(FAILURE_REASONS).optional(),
  lastFailureMessage: z.string().optional(),
  failedAt: z.string().datetime().optional(),
});
export type ManifestEntryState = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z.object({
  manifestId: z.string().min(1),
  cliVersion: z.string(),
  redactionPolicyVersion: z.string(),
  sourceKind: z.string(),
  expectedSessionCount: z.number().int().min(1),
  endpointUrl: z.string(),
  userId: z.string(),
  entries: z.array(manifestEntrySchema),
});
export type ManifestState = z.infer<typeof manifestSchema>;

export const resumeStateSchema = z.object({
  schemaVersion: z.literal(RESUME_SCHEMA_VERSION),
  manifest: manifestSchema,
  // Aggregate { category: count } for the batch, persisted so a later run can
  // still complete the manifest when this one dies after the last PUT but
  // before completeManifest. Optional: absent in states written by older CLIs.
  redactionTotals: z.record(z.string(), z.number().int().min(0)).optional(),
  beganAt: z.string().datetime(),
});
export type ResumeState = z.infer<typeof resumeStateSchema>;

export interface ResumeStoreKey {
  endpointUrl: string;
  userId: string;
}

export interface ResumeStoreOptions {
  cwd?: string;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function projectName(key: ResumeStoreKey): string {
  return `${NAMESPACES.resume}__${sanitize(key.endpointUrl)}__${sanitize(key.userId)}`;
}

export class ResumeStore {
  private readonly store: Conf<{ state: ResumeState | null }>;
  // In-memory write-through cache (undefined = not yet loaded). Conf re-reads
  // and re-parses the file on every `get`, and updateEntry runs load + save per
  // status transition — ~3 per session — so a large batch would otherwise
  // re-validate the full entry list hundreds of times. Nothing else writes the
  // file while an upload command holds this instance.
  private cached: ResumeState | null | undefined;

  constructor(key: ResumeStoreKey, options: ResumeStoreOptions = {}) {
    const name = projectName(key);
    this.store = new Conf<{ state: ResumeState | null }>({
      projectName: name,
      defaults: { state: null },
      // Owner-only: entries carry absolute paths, session ids, and failure text.
      configFileMode: 0o600,
      ...(options.cwd !== undefined ? { cwd: options.cwd, configName: name } : {}),
    });
  }

  load(): ResumeState | null {
    if (this.cached !== undefined) return this.cached;
    const raw = this.store.get("state");
    if (raw === null || raw === undefined) {
      this.cached = null;
      return null;
    }
    const parsed = resumeStateSchema.safeParse(raw);
    if (!parsed.success) {
      this.clear();
      return null;
    }
    this.cached = parsed.data;
    return parsed.data;
  }

  save(state: ResumeState): void {
    this.store.set("state", state);
    this.cached = state;
  }

  clear(): void {
    this.store.set("state", null);
    this.cached = null;
  }

  updateEntry(sessionId: string, updater: (entry: ManifestEntryState) => ManifestEntryState): void {
    const current = this.load();
    if (!current) return;
    const entries = current.manifest.entries.map((entry) =>
      entry.sessionId === sessionId ? updater(entry) : entry,
    );
    this.save({
      ...current,
      manifest: { ...current.manifest, entries },
    });
  }

  get path(): string {
    return this.store.path;
  }
}

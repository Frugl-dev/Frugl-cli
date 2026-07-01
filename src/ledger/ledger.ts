import Conf from "conf";
import { z } from "zod";
import { NAMESPACES } from "../lib/paths.js";

const LEDGER_SCHEMA_VERSION = 2 as const;

export const ledgerEntrySchema = z.object({
  sessionId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  lastUploadedAt: z.string().datetime(),
  manifestId: z.string().min(1),
  // v2: filesystem fast-path stat, captured from the SessionRef at upload time.
  // When a re-discovered file matches this exact path + size + mtime it cannot
  // have changed, so classify can report it unchanged without reading, parsing,
  // or anonymizing it. All optional so v1 entries (and any future writer that
  // omits them) validate — a missing stat simply disables the fast path and
  // falls back to the parse + content-hash check, which backfills these on the
  // next successful upload. See classify.ts.
  sourceFilePath: z.string().optional(),
  mtimeMs: z.number().optional(),
  byteSizeOnDisk: z.number().optional(),
  derivation: z.enum(["native", "path-hash"]).optional(),
  // The redaction policy version this entry's contentHash was computed under.
  // The stat fast path may only trust an entry when this still matches the
  // running policy — a policy bump changes the content hash and must force a
  // re-anonymize/re-upload even for a byte-identical file.
  policyVersion: z.string().optional(),
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const ledgerShapeSchema = z.object({
  schemaVersion: z.literal(LEDGER_SCHEMA_VERSION),
  entries: z.record(z.string(), ledgerEntrySchema),
});

export type LedgerShape = z.infer<typeof ledgerShapeSchema>;

// Version-tolerant view used only for forward migration: the entry shape is
// backward-compatible (v2 only adds optional fields), so an older store differs
// solely in its schemaVersion stamp. Accept any numeric version, then re-stamp.
const migratableShapeSchema = z.object({
  schemaVersion: z.number(),
  entries: z.record(z.string(), ledgerEntrySchema),
});

export interface LedgerKey {
  endpointUrl: string;
  userId: string;
}

export interface LedgerStoreOptions {
  /** Override the conf state-dir (test isolation). */
  cwd?: string;
}

function projectName(key: LedgerKey): string {
  return `${NAMESPACES.ledger}__${sanitize(key.endpointUrl)}__${sanitize(key.userId)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export class Ledger {
  private readonly store: Conf<{ data: LedgerShape }>;

  constructor(key: LedgerKey, options: LedgerStoreOptions = {}) {
    const name = projectName(key);
    this.store = new Conf<{ data: LedgerShape }>({
      projectName: name,
      defaults: { data: { schemaVersion: LEDGER_SCHEMA_VERSION, entries: {} } },
      ...(options.cwd !== undefined ? { cwd: options.cwd, configName: name } : {}),
    });
  }

  read(): LedgerShape {
    const raw = this.store.get("data");
    const parsed = ledgerShapeSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // Migrate an older-but-compatible store forward (e.g. v1 → v2, which only
    // added optional stat fields). Preserve every entry and just re-stamp the
    // version so upgrading does NOT wipe the ledger and re-anonymize everything.
    // Only older versions are migrated: an unknown *future* version may carry an
    // incompatible entry shape we must not silently adopt, so it falls through to
    // a fresh (empty) ledger like any unreadable store.
    const migratable = migratableShapeSchema.safeParse(raw);
    if (migratable.success && migratable.data.schemaVersion < LEDGER_SCHEMA_VERSION) {
      const upgraded: LedgerShape = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        entries: migratable.data.entries,
      };
      this.store.set("data", upgraded);
      return upgraded;
    }
    const fresh: LedgerShape = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      entries: {},
    };
    this.store.set("data", fresh);
    return fresh;
  }

  // Path-keyed view of the ledger for the classify fast path: only entries that
  // recorded a source path participate. Built once per classification pass so
  // the per-session lookup is O(1) rather than re-scanning all entries.
  buildStatIndex(): Map<string, LedgerEntry> {
    const index = new Map<string, LedgerEntry>();
    for (const entry of Object.values(this.read().entries)) {
      if (entry.sourceFilePath !== undefined) index.set(entry.sourceFilePath, entry);
    }
    return index;
  }

  getEntry(sessionId: string): LedgerEntry | undefined {
    return this.read().entries[sessionId];
  }

  upsertEntry(entry: LedgerEntry): void {
    const current = this.read();
    const next: LedgerShape = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      entries: { ...current.entries, [entry.sessionId]: entry },
    };
    this.store.set("data", next);
  }

  upsertMany(entries: LedgerEntry[]): void {
    if (entries.length === 0) return;
    const current = this.read();
    const merged: Record<string, LedgerEntry> = { ...current.entries };
    for (const entry of entries) {
      merged[entry.sessionId] = entry;
    }
    this.store.set("data", {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      entries: merged,
    });
  }

  clear(): void {
    this.store.set("data", { schemaVersion: LEDGER_SCHEMA_VERSION, entries: {} });
  }

  get path(): string {
    return this.store.path;
  }
}

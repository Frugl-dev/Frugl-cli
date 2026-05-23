import Conf from "conf";
import { z } from "zod";
import { NAMESPACES } from "../lib/paths.js";

const LEDGER_SCHEMA_VERSION = 1 as const;

export const ledgerEntrySchema = z.object({
  sessionId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  lastUploadedAt: z.string().datetime(),
  manifestId: z.string().min(1),
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const ledgerShapeSchema = z.object({
  schemaVersion: z.literal(LEDGER_SCHEMA_VERSION),
  entries: z.record(ledgerEntrySchema),
});

export type LedgerShape = z.infer<typeof ledgerShapeSchema>;

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
    const fresh: LedgerShape = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      entries: {},
    };
    this.store.set("data", fresh);
    return fresh;
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

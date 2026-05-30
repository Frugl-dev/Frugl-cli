import { readFile } from "node:fs/promises";
import type { ParsedSession, SessionRef } from "../types.js";
import { CLAUDE_SOURCE_KIND } from "./discover.js";
import { deriveClaudeIdentity } from "./identity.js";

export async function parseClaudeSession(ref: SessionRef): Promise<ParsedSession> {
  const text = await readFile(ref.absolutePath, "utf8");
  const lines = text.split(/\r?\n/);
  const records: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      records.push({ _raw: trimmed });
    }
  }
  const firstRecord = records[0] ?? null;
  const identity = deriveClaudeIdentity(ref, firstRecord);

  // Surface the working dir + work-time branch from the first record that carries
  // each. These are NOT added to `records`, so the anonymizer never sees them.
  let cwd: string | undefined;
  let recordedBranch: string | undefined;
  let startedAt: Date | undefined;
  for (const record of records) {
    if (startedAt === undefined) {
      const ts = readNonEmptyString(record, "timestamp");
      if (ts) {
        const d = new Date(ts);
        if (!isNaN(d.getTime())) startedAt = d;
      }
    }
    if (cwd === undefined) cwd = readNonEmptyString(record, "cwd");
    if (recordedBranch === undefined) recordedBranch = readNonEmptyString(record, "gitBranch");
    if (startedAt !== undefined && cwd !== undefined && recordedBranch !== undefined) break;
  }

  return {
    sourceKind: CLAUDE_SOURCE_KIND,
    ref,
    identity,
    records,
    meta: startedAt !== undefined ? { startedAt } : {},
    ...(cwd !== undefined ? { cwd } : {}),
    ...(recordedBranch !== undefined ? { recordedBranch } : {}),
  };
}

function readNonEmptyString(record: unknown, key: string): string | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

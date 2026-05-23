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
  return {
    sourceKind: CLAUDE_SOURCE_KIND,
    ref,
    identity,
    records,
  };
}

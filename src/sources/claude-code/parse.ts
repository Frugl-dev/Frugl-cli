import { readFile } from "node:fs/promises";
import type { ParsedSession, SessionRef } from "../types.js";
import { parseNdjson } from "../ndjson.js";
import { CLAUDE_SOURCE_KIND } from "./discover.js";
import { deriveClaudeIdentity } from "./identity.js";

export async function parseClaudeSession(ref: SessionRef): Promise<ParsedSession> {
  const text = await readFile(ref.absolutePath, "utf8");
  const records = parseNdjson(text);
  const firstRecord = records[0] ?? null;
  const identity = deriveClaudeIdentity(ref, firstRecord);

  // Surface the working dir + work-time branch from the first record that carries
  // each. These are NOT added to `records`, so the anonymizer never sees them.
  let cwd: string | undefined;
  let recordedBranch: string | undefined;
  for (const record of records) {
    if (cwd === undefined) cwd = readNonEmptyString(record, "cwd");
    if (recordedBranch === undefined) recordedBranch = readNonEmptyString(record, "gitBranch");
    if (cwd !== undefined && recordedBranch !== undefined) break;
  }

  return {
    sourceKind: CLAUDE_SOURCE_KIND,
    ref,
    identity,
    records,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(recordedBranch !== undefined ? { recordedBranch } : {}),
  };
}

function readNonEmptyString(record: unknown, key: string): string | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

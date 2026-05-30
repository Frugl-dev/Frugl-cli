import { readFile } from "node:fs/promises";
import type { ParsedSession, SessionRef } from "../types.js";
import { GEMINI_SOURCE_KIND } from "./discover.js";
import { deriveGeminiIdentity } from "./identity.js";

export async function parseGeminiSession(ref: SessionRef): Promise<ParsedSession> {
  const text = await readFile(ref.absolutePath, "utf8");
  let records: unknown[] = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) records = parsed;
  } catch {
    records = [];
  }
  const firstRecord = records[0] ?? null;
  const identity = deriveGeminiIdentity(ref, firstRecord);

  let startedAt: Date | undefined;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const ts = (record as Record<string, unknown>)["timestamp"];
    if (typeof ts === "string" && ts) {
      const d = new Date(ts);
      if (!isNaN(d.getTime())) {
        startedAt = d;
        break;
      }
    }
  }

  return {
    sourceKind: GEMINI_SOURCE_KIND,
    ref,
    identity,
    records,
    meta: startedAt !== undefined ? { startedAt } : {},
  };
}

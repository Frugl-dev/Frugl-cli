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
  return { sourceKind: GEMINI_SOURCE_KIND, ref, identity, records };
}

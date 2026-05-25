import { readFile } from "node:fs/promises";
import type { ParsedSession, SessionRef } from "../types.js";
import { CODEX_SOURCE_KIND } from "./discover.js";
import { deriveCodexIdentity } from "./identity.js";

export async function parseCodexSession(ref: SessionRef): Promise<ParsedSession> {
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
  const identity = deriveCodexIdentity(ref, firstRecord);

  let cwd: string | undefined;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const r = record as Record<string, unknown>;
    if (r["type"] === "session_meta") {
      const payload = r["payload"];
      if (payload && typeof payload === "object") {
        const p = payload as Record<string, unknown>;
        if (typeof p["cwd"] === "string" && p["cwd"].length > 0) {
          cwd = p["cwd"];
        }
      }
      break;
    }
  }

  return {
    sourceKind: CODEX_SOURCE_KIND,
    ref,
    identity,
    records,
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

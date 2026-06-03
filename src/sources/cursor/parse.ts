import { readFile } from "node:fs/promises";
import type { ParsedSession, SessionRef } from "../types.js";
import { parseNdjson } from "../ndjson.js";
import { CURSOR_SOURCE_KIND } from "./discover.js";
import { deriveCursorIdentity } from "./identity.js";

export async function parseCursorSession(ref: SessionRef): Promise<ParsedSession> {
  const text = await readFile(ref.absolutePath, "utf8");
  const records = parseNdjson(text);
  const identity = deriveCursorIdentity(ref);
  return { sourceKind: CURSOR_SOURCE_KIND, ref, identity, records };
}

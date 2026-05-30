import type { SessionIdentity, SessionRef } from "../types.js";
import { resolveIdentity } from "../identity.js";

export function deriveGeminiIdentity(ref: SessionRef, firstRecord: unknown): SessionIdentity {
  return resolveIdentity({ ref, nativeId: readSessionId(firstRecord) });
}

function readSessionId(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const id = (record as Record<string, unknown>)["sessionId"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

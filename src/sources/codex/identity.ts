import type { SessionIdentity, SessionRef } from "../types.js";
import { resolveIdentity } from "../identity.js";

export function deriveCodexIdentity(ref: SessionRef, firstRecord: unknown): SessionIdentity {
  return resolveIdentity({ ref, nativeId: readSessionId(firstRecord) });
}

function readSessionId(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const r = record as Record<string, unknown>;
  if (r["type"] !== "session_meta") return undefined;
  const payload = r["payload"];
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

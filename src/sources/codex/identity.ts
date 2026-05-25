import type { SessionIdentity, SessionRef } from "../types.js";
import { pathHash } from "../claude-code/identity.js";

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_ID_LENGTH = 128;

export function deriveCodexIdentity(ref: SessionRef, firstRecord: unknown): SessionIdentity {
  const native = readSessionId(firstRecord);
  if (native && SEGMENT_PATTERN.test(native) && native.length <= MAX_ID_LENGTH) {
    return { sessionId: native, derivation: "native" };
  }
  return { sessionId: pathHash(ref.absolutePath), derivation: "path-hash" };
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

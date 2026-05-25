import type { SessionIdentity, SessionRef } from "../types.js";
import { pathHash } from "../claude-code/identity.js";

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_ID_LENGTH = 128;

export function deriveGeminiIdentity(ref: SessionRef, firstRecord: unknown): SessionIdentity {
  const native = readSessionId(firstRecord);
  if (native && SEGMENT_PATTERN.test(native) && native.length <= MAX_ID_LENGTH) {
    return { sessionId: native, derivation: "native" };
  }
  return { sessionId: pathHash(ref.absolutePath), derivation: "path-hash" };
}

function readSessionId(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const id = (record as Record<string, unknown>)["sessionId"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

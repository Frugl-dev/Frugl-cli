import type { SessionIdentity, SessionRef } from "../types.js";
import { pathHash } from "../claude-code/identity.js";

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_ID_LENGTH = 128;

export function deriveCursorIdentity(ref: SessionRef): SessionIdentity {
  const native = extractSessionDirFromPath(ref.absolutePath);
  if (native && SEGMENT_PATTERN.test(native) && native.length <= MAX_ID_LENGTH) {
    return { sessionId: native, derivation: "native" };
  }
  return { sessionId: pathHash(ref.absolutePath), derivation: "path-hash" };
}

function extractSessionDirFromPath(absolutePath: string): string | undefined {
  // Normalize separators for cross-platform matching
  const normalized = absolutePath.replace(/\\/g, "/");
  const marker = "/agent-transcripts/";
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return undefined;
  const after = normalized.slice(idx + marker.length);
  // The session UUID is the first path segment after agent-transcripts/
  const segment = after.split("/")[0];
  return segment && segment.length > 0 ? segment : undefined;
}

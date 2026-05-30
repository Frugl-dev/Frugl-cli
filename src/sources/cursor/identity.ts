import type { SessionIdentity, SessionRef } from "../types.js";
import { resolveIdentity } from "../identity.js";

export function deriveCursorIdentity(ref: SessionRef): SessionIdentity {
  return resolveIdentity({ ref, nativeId: extractSessionDirFromPath(ref.absolutePath) });
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

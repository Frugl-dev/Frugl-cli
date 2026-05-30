import type { SessionIdentity, SessionRef } from "../types.js";
import { resolveIdentity } from "../identity.js";
import { extractWorktreePath } from "./project.js";

export function deriveClaudeIdentity(ref: SessionRef, firstRecord: unknown): SessionIdentity {
  // Claude reuses one session UUID across a main checkout and its worktree
  // copies, so the same native id can appear in multiple files. Only the main
  // checkout keeps the native id; worktree copies derive a path-unique id so the
  // two never collide on the cloud's UUID primary key.
  const isWorktreeCopy = extractWorktreePath(ref.absolutePath) !== null;
  return resolveIdentity({
    ref,
    nativeId: readNativeSessionId(firstRecord),
    allowNativeReuse: !isWorktreeCopy,
  });
}

function readNativeSessionId(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const candidate = (record as { sessionId?: unknown }).sessionId;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return undefined;
}

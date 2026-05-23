import { createHash } from "node:crypto";
import path from "node:path";
import type { SessionIdentity, SessionRef } from "../types.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_ID_LENGTH = 128;

export function deriveClaudeIdentity(ref: SessionRef, firstRecord: unknown): SessionIdentity {
  const native = readNativeSessionId(firstRecord);
  if (native && SESSION_ID_PATTERN.test(native) && native.length <= MAX_ID_LENGTH) {
    return { sessionId: native, derivation: "native" };
  }
  return { sessionId: pathHash(ref.absolutePath), derivation: "path-hash" };
}

function readNativeSessionId(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const candidate = (record as { sessionId?: unknown }).sessionId;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return undefined;
}

export function pathHash(absolutePath: string): string {
  const canonical = canonicalize(absolutePath);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

function canonicalize(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

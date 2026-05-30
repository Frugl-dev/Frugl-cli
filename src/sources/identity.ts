import { createHash } from "node:crypto";
import path from "node:path";
import type { SessionIdentity, SessionRef } from "./types.js";

// Cloud ingest keys every session by a UUID (session_objects.id is a uuid PK),
// so a session id MUST be a canonical UUID and MUST be unique per physical file.
// This module is the single place that guarantees both:
//   - a source's native id is reused only when it is itself a valid UUID;
//   - otherwise (and for worktree duplicates) a stable UUIDv5 is derived from
//     the file path, so the value is always a UUID and never collides.
// The raw native id is preserved on `nativeSessionId` so callers can still group
// physical files back to one logical session.

// Fixed namespace for poppi-derived session UUIDs (UUIDv5). Never change this —
// it would re-key every path-derived session.
const POPPI_NAMESPACE = "6e1f93b2-5a0e-5c3a-9b7e-2f0a8c4d6e10";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// Canonical, case-folded absolute path — the same normalization the legacy
// path-hash used, so a given file derives the same id across runs.
function canonicalize(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

// RFC 4122 UUIDv5 (SHA-1, name-based) over node:crypto — avoids a runtime dep.
export function uuidv5(name: string, namespace: string = POPPI_NAMESPACE): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A stable UUID derived from the session file's path. Unique per physical file,
// so worktree copies that share a native id still get distinct ids.
export function deriveSessionUuid(absolutePath: string): string {
  return uuidv5(canonicalize(absolutePath));
}

export interface ResolveIdentityInput {
  ref: SessionRef;
  // The source's own session id from the file content/path, if any.
  nativeId: string | undefined;
  // Reuse a valid-UUID native id as the session id. Pass false for files that
  // can share a native id across physical copies (Claude worktrees), forcing a
  // path-derived id so the copies never collide.
  allowNativeReuse?: boolean;
}

// Resolve a session identity that is always a valid UUID. Reuses the native id
// when it is a real UUID (and reuse is allowed); otherwise derives one from the
// path. The native id, when present, is always preserved on `nativeSessionId`.
export function resolveIdentity(input: ResolveIdentityInput): SessionIdentity {
  const { ref, nativeId, allowNativeReuse = true } = input;
  const hasNative = typeof nativeId === "string" && nativeId.length > 0;

  if (hasNative && allowNativeReuse && isUuid(nativeId)) {
    return { sessionId: nativeId, nativeSessionId: nativeId, derivation: "native" };
  }
  return {
    sessionId: deriveSessionUuid(ref.absolutePath),
    ...(hasNative ? { nativeSessionId: nativeId } : {}),
    derivation: "path-hash",
  };
}

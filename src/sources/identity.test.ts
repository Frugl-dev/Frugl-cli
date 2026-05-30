import { describe, it, expect } from "vitest";
import { deriveClaudeIdentity } from "./claude-code/identity.js";
import { resolveIdentity, deriveSessionUuid, uuidv5, isUuid } from "./identity.js";
import type { SessionRef } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ref(absolutePath: string): SessionRef {
  return { sourceKind: "claude-code", absolutePath, byteSizeOnDisk: 100, mtimeMs: 1 };
}

describe("uuidv5 / deriveSessionUuid", () => {
  it("produces a valid v5 UUID and is deterministic", () => {
    const a = uuidv5("hello");
    const b = uuidv5("hello");
    expect(a).toMatch(UUID_RE);
    expect(a).toBe(b);
    expect(a[14]).toBe("5"); // version nibble
  });

  it("different names produce different UUIDs", () => {
    expect(uuidv5("a")).not.toBe(uuidv5("b"));
  });

  it("derives the same UUID for the same path across calls", () => {
    const p = "/Users/x/.claude/projects/proj/abc.jsonl";
    expect(deriveSessionUuid(p)).toBe(deriveSessionUuid(p));
  });

  it("matches the RFC 4122 v5 test vector (dns namespace, python.org)", () => {
    // uuid5(NAMESPACE_DNS, "python.org") = 886313e1-3b8a-5372-9b90-0c9aee199e5d
    const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(uuidv5("python.org", DNS)).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });
});

describe("isUuid", () => {
  it("accepts canonical UUIDs and rejects others", () => {
    expect(isUuid("019e38ab-78b3-7c30-b22d-f27544f97fda")).toBe(true);
    expect(isUuid("codex-session-abc123")).toBe(false);
    expect(isUuid("2c4d190b9e8f208e7ecd9a9f")).toBe(false); // legacy 24-hex path hash
  });
});

describe("resolveIdentity", () => {
  it("reuses a native id that is already a UUID", () => {
    const nativeId = "019e38ab-78b3-7c30-b22d-f27544f97fda";
    const id = resolveIdentity({ ref: ref("/a/b.jsonl"), nativeId });
    expect(id).toEqual({ sessionId: nativeId, nativeSessionId: nativeId, derivation: "native" });
  });

  it("derives a UUID but preserves a non-UUID native id", () => {
    const id = resolveIdentity({ ref: ref("/a/b.jsonl"), nativeId: "not-a-uuid" });
    expect(id.sessionId).toMatch(UUID_RE);
    expect(id.derivation).toBe("path-hash");
    expect(id.nativeSessionId).toBe("not-a-uuid");
  });

  it("derives (no nativeSessionId) when there is no native id", () => {
    const id = resolveIdentity({ ref: ref("/a/b.jsonl"), nativeId: undefined });
    expect(id.sessionId).toMatch(UUID_RE);
    expect(id.derivation).toBe("path-hash");
    expect(id.nativeSessionId).toBeUndefined();
  });

  it("derives from the path when native reuse is disallowed (preserving the native id)", () => {
    const nativeId = "019e38ab-78b3-7c30-b22d-f27544f97fda";
    const id = resolveIdentity({ ref: ref("/a/b.jsonl"), nativeId, allowNativeReuse: false });
    expect(id.sessionId).not.toBe(nativeId);
    expect(id.sessionId).toMatch(UUID_RE);
    expect(id.nativeSessionId).toBe(nativeId);
    expect(id.derivation).toBe("path-hash");
  });
});

describe("deriveClaudeIdentity — worktree collision handling", () => {
  const nativeId = "6ecdce60-e6aa-49d0-a001-7b43ae9fdf14";
  const firstRecord = { sessionId: nativeId };

  it("keeps the native UUID for a main-checkout session", () => {
    const id = deriveClaudeIdentity(
      ref("/Users/x/.claude/projects/-Users-x-proj/6ecdce60-e6aa-49d0-a001-7b43ae9fdf14.jsonl"),
      firstRecord,
    );
    expect(id.sessionId).toBe(nativeId);
    expect(id.derivation).toBe("native");
  });

  it("derives a distinct id for a worktree copy sharing the same native id", () => {
    const main = deriveClaudeIdentity(
      ref("/Users/x/.claude/projects/-Users-x-proj/6ecdce60-e6aa-49d0-a001-7b43ae9fdf14.jsonl"),
      firstRecord,
    );
    const worktree = deriveClaudeIdentity(
      ref(
        "/Users/x/.claude/projects/-Users-x-proj--claude-worktrees-feat-x/6ecdce60-e6aa-49d0-a001-7b43ae9fdf14.jsonl",
      ),
      firstRecord,
    );
    // No collision on the cloud's UUID primary key…
    expect(worktree.sessionId).not.toBe(main.sessionId);
    expect(worktree.sessionId).toMatch(UUID_RE);
    // …but both still point back to the one logical session.
    expect(worktree.nativeSessionId).toBe(nativeId);
    expect(main.nativeSessionId).toBe(nativeId);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DESCRIPTORS,
  claude,
  codex,
  cursor,
  gemini,
  segmentAfter,
  type ProviderDescriptor,
} from "./descriptor.js";
import { discover, parse, probe, toSource } from "./walker.js";
import type { SessionRef } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ref(absolutePath: string, sourceKind: string): SessionRef {
  return { sourceKind, absolutePath, byteSizeOnDisk: 100, mtimeMs: 1 };
}

// A real session file at the descriptor's first glob root, exercising the actual
// layout. Returns the absolute path written.
function seedSession(home: string, d: ProviderDescriptor, contents: string): string {
  // Translate the descriptor's first glob into a concrete relative path.
  const rel = d.layout.globs[0]!.replace("**/", "session-dir/")
    .replace("*/", "session-dir/")
    .replace("*.jsonl", "session.jsonl");
  const target = path.join(home, ...d.layout.rootSegments, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return path.resolve(target);
}

// ── probe (FR-019) ─────────────────────────────────────────────────────────────

describe("walker.probe", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-walker-probe-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.each(DESCRIPTORS)("returns false when $id's probe path is absent", async (d) => {
    expect(await probe(d, { homeDir: home })).toBe(false);
  });

  it.each(DESCRIPTORS)("returns true once $id's probe path exists", async (d) => {
    const target = path.join(home, ...d.layout.probeSegments);
    // The cursor probe targets a file (state.vscdb); the rest target dirs. Either
    // way, materialising the path makes the probe report installed.
    mkdirSync(path.dirname(target), { recursive: true });
    if (path.extname(target)) writeFileSync(target, "");
    else mkdirSync(target, { recursive: true });
    expect(await probe(d, { homeDir: home })).toBe(true);
  });

  it("surfaces a non-ENOENT error (e.g. EACCES) instead of returning false", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod no-op
    const locked = path.join(home, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      await expect(probe(claude, { homeDir: locked })).rejects.toThrow(
        /permission denied|EACCES|EPERM/i,
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

// ── discover ─────────────────────────────────────────────────────────────────

describe("walker.discover", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-walker-discover-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.each(DESCRIPTORS)("returns [] when $id's root is absent", async (d) => {
    expect(await discover(d, { homeDir: home })).toEqual([]);
  });

  it.each(DESCRIPTORS)("returns a ref with the right sourceKind/size/mtime for $id", async (d) => {
    const abs = seedSession(home, d, '{"sessionId":"x"}\n');
    const refs = await discover(d, { homeDir: home });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceKind).toBe(d.sourceKind);
    expect(refs[0]!.absolutePath).toBe(abs);
    expect(refs[0]!.byteSizeOnDisk).toBeGreaterThan(0);
    expect(refs[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it("honors the glob, skipping non-matching files (gemini wants logs.json only)", async () => {
    const dir = path.join(home, ".gemini", "tmp", "sess");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "other.json"), "[]");
    writeFileSync(path.join(dir, "logs.json"), "[]");
    const refs = await discover(gemini, { homeDir: home });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.absolutePath).toContain("logs.json");
  });

  it("yields refs for files only, never directories", async () => {
    // A directory matching the glob shape must not become a ref.
    const root = path.join(home, ".codex", "sessions", "2026");
    mkdirSync(path.join(root, "nested.jsonl"), { recursive: true }); // a dir named *.jsonl
    writeFileSync(path.join(root, "real.jsonl"), '{"type":"session_meta"}\n');
    const refs = await discover(codex, { homeDir: home });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.absolutePath).toContain("real.jsonl");
  });
});

// ── decode (via parse) ─────────────────────────────────────────────────────────

describe("walker decode dispatch", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-walker-decode-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("ndjson: parses lines, skips blanks, recovers malformed as _raw", async () => {
    const file = path.join(home, "s.jsonl");
    writeFileSync(file, '{"a":1}\n\nnot json\n{"b":2}\n');
    const parsed = await parse(codex, ref(file, "codex"));
    expect(parsed.records).toEqual([{ a: 1 }, { _raw: "not json" }, { b: 2 }]);
  });

  it("json-array: a valid array decodes to its elements", async () => {
    const file = path.join(home, "logs.json");
    writeFileSync(file, '[{"sessionId":"a"},{"sessionId":"b"}]');
    const parsed = await parse(gemini, ref(file, "gemini"));
    expect(parsed.records).toHaveLength(2);
  });

  it("json-array: a non-array JSON value decodes to []", async () => {
    const file = path.join(home, "logs.json");
    writeFileSync(file, '{"sessionId":"a"}');
    const parsed = await parse(gemini, ref(file, "gemini"));
    expect(parsed.records).toEqual([]);
  });

  it("json-array: malformed JSON decodes to []", async () => {
    const file = path.join(home, "logs.json");
    writeFileSync(file, "{not json");
    const parsed = await parse(gemini, ref(file, "gemini"));
    expect(parsed.records).toEqual([]);
  });
});

// ── descriptor conformance (a 5th provider adds one row to DESCRIPTORS) ──────────

describe("descriptor conformance", () => {
  it.each(DESCRIPTORS)("$id is a well-formed descriptor", (d) => {
    expect(d.layout.probeSegments.length).toBeGreaterThan(0);
    expect(d.layout.rootSegments.length).toBeGreaterThan(0);
    expect(d.layout.globs.length).toBeGreaterThan(0);
    expect(d.layout.globs.every((g) => g.length > 0)).toBe(true);
    expect(["ndjson", "json-array"]).toContain(d.format.kind);
    expect(typeof d.extractNativeId).toBe("function");
    expect(typeof d.deriveProjects).toBe("function");
    expect(d.sourceKind.length).toBeGreaterThan(0);
    expect(d.formatVersion.length).toBeGreaterThan(0);
  });

  it("keeps id and sourceKind distinct for claude (wire-stable invariant)", () => {
    expect(claude.id).toBe("claude");
    expect(claude.sourceKind).toBe("claude-code");
  });

  it("pins every wire-stable formatVersion string", () => {
    expect(claude.formatVersion).toBe("claude-jsonl-2026-04");
    expect(codex.formatVersion).toBe("codex-jsonl-2026-05");
    expect(cursor.formatVersion).toBe("cursor-jsonl-2026-05");
    expect(gemini.formatVersion).toBe("gemini-json-2026-05");
  });
});

// ── per-provider extractors (pure, no fs) ───────────────────────────────────────

function ctx(sessionRef: SessionRef, records: unknown[]) {
  return { ref: sessionRef, records, firstRecord: records[0] ?? null };
}

function refAt(absolutePath: string): SessionRef {
  return { sourceKind: "x", absolutePath, byteSizeOnDisk: 1, mtimeMs: 1 };
}

describe("cursor.extractNativeId / segmentAfter", () => {
  it("reads the UUID segment after agent-transcripts/", () => {
    const r = refAt(
      "/h/.cursor/projects/p/agent-transcripts/aaaabbbb-1111-2222-3333-444444444444/f.jsonl",
    );
    expect(cursor.extractNativeId(ctx(r, []))).toBe("aaaabbbb-1111-2222-3333-444444444444");
  });

  it("handles Windows-style separators", () => {
    const r = refAt(
      "C:\\Users\\u\\.cursor\\projects\\p\\agent-transcripts\\cccc0000-dddd-1111-eeee-222222222222\\f.jsonl",
    );
    expect(cursor.extractNativeId(ctx(r, []))).toBe("cccc0000-dddd-1111-eeee-222222222222");
  });

  it("returns undefined when the marker is absent", () => {
    expect(segmentAfter("/some/other/path/session.jsonl", "/agent-transcripts/")).toBeUndefined();
    expect(cursor.extractNativeId(ctx(refAt("/some/other/session.jsonl"), []))).toBeUndefined();
  });
});

describe("claude.allowNativeReuse (worktree suppression)", () => {
  it("allows reuse for a main checkout", () => {
    const r = refAt("/h/.claude/projects/-Users-x-proj/sess.jsonl");
    expect(claude.allowNativeReuse!(ctx(r, []))).toBe(true);
  });

  it("suppresses reuse for a worktree copy", () => {
    const r = refAt("/h/.claude/projects/-Users-x-proj--claude-worktrees-feat/sess.jsonl");
    expect(claude.allowNativeReuse!(ctx(r, []))).toBe(false);
  });
});

describe("codex.extractNativeId / extractMetadata (session_meta traversal)", () => {
  const meta = { type: "session_meta", payload: { id: "s-1", cwd: "/proj" } };

  it("reads payload.id from a session_meta first record", () => {
    expect(codex.extractNativeId(ctx(refAt("/x"), [meta]))).toBe("s-1");
  });

  it("reads payload.cwd as metadata", () => {
    expect(codex.extractMetadata!(ctx(refAt("/x"), [meta]))).toEqual({ cwd: "/proj" });
  });

  it("returns undefined when the first record is not session_meta", () => {
    const other = { type: "event_msg", payload: {} };
    expect(codex.extractNativeId(ctx(refAt("/x"), [other]))).toBeUndefined();
  });
});

describe("gemini.extractNativeId (sessionId read)", () => {
  it("reads sessionId off the first array element", () => {
    const first = { sessionId: "00000000-0000-0000-0000-000000000401" };
    expect(gemini.extractNativeId(ctx(refAt("/x"), [first]))).toBe(first.sessionId);
  });

  it("returns undefined when sessionId is missing", () => {
    expect(gemini.extractNativeId(ctx(refAt("/x"), [{ messageId: "m" }]))).toBeUndefined();
  });
});

// ── end-to-end smoke through toSource (one provider, kept per the RFC) ───────────

describe("toSource(codex) end-to-end", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-walker-e2e-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("discovers, parses, derives identity, and surfaces cwd via the Source adapter", async () => {
    const source = toSource(codex);
    expect(source.kind).toBe("codex");
    expect(source.formatVersion).toBe("codex-jsonl-2026-05");

    const dir = path.join(home, ".codex", "sessions", "2026", "05", "25");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "session.jsonl"),
      '{"type":"session_meta","payload":{"id":"00000000-0000-4000-8000-0000000000c0","cwd":"/home/me/app"}}\n' +
        '{"type":"event_msg","payload":{"role":"user","content":"hi"}}\n',
    );

    const refs = await source.discover({ homeDir: home });
    expect(refs).toHaveLength(1);

    const parsed = await source.parse(refs[0]!);
    expect(parsed.sourceKind).toBe("codex");
    expect(parsed.records).toHaveLength(2);
    expect(parsed.cwd).toBe("/home/me/app");
    expect(parsed.identity.sessionId).toBe("00000000-0000-4000-8000-0000000000c0");
    expect(parsed.identity.derivation).toBe("native");

    // deriveIdentity via the Source matches the parse-time identity.
    const reDerived = source.deriveIdentity(refs[0]!, parsed);
    expect(reDerived.sessionId).toBe(parsed.identity.sessionId);
    expect(reDerived.sessionId).toMatch(UUID_RE);
  });
});

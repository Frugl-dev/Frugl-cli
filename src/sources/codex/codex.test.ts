import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODEX_SOURCE_KIND, CODEX_FORMAT_VERSION, discoverCodexSessions } from "./discover.js";
import { deriveCodexIdentity } from "./identity.js";
import { parseCodexSession } from "./parse.js";
import type { SessionRef } from "../types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── discover ─────────────────────────────────────────────────────────────────

describe("CODEX constants", () => {
  it("CODEX_SOURCE_KIND is codex", () => {
    expect(CODEX_SOURCE_KIND).toBe("codex");
  });

  it("CODEX_FORMAT_VERSION is codex-jsonl-2026-05", () => {
    expect(CODEX_FORMAT_VERSION).toBe("codex-jsonl-2026-05");
  });
});

describe("discoverCodexSessions", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), "frugl-codex-discover-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns empty array when codex sessions dir is absent", async () => {
    const refs = await discoverCodexSessions({ homeDir: tempHome });
    expect(refs).toEqual([]);
  });

  it("returns refs for jsonl files under codex sessions", async () => {
    const dir = path.join(tempHome, ".codex", "sessions", "2026", "05", "25");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "session.jsonl"),
      '{"type":"session_meta","timestamp":"2026-05-25T10:00:00Z","payload":{"id":"sess-001","cwd":"/proj"}}\n',
    );

    const refs = await discoverCodexSessions({ homeDir: tempHome });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceKind).toBe("codex");
    expect(refs[0]!.absolutePath).toContain("session.jsonl");
    expect(refs[0]!.byteSizeOnDisk).toBeGreaterThan(0);
  });

  it("discovers files at multiple nesting levels", async () => {
    for (const sub of ["2026/05/25", "2026/05/26"]) {
      const dir = path.join(tempHome, ".codex", "sessions", sub);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "s.jsonl"), '{"type":"session_meta"}\n');
    }

    const refs = await discoverCodexSessions({ homeDir: tempHome });
    expect(refs).toHaveLength(2);
  });
});

// ── identity ─────────────────────────────────────────────────────────────────

describe("deriveCodexIdentity", () => {
  it("extracts id from session_meta first line", () => {
    const firstRecord = {
      type: "session_meta",
      timestamp: "2026-05-25T10:00:00Z",
      payload: { id: "019e38ab-78b3-7c30-b22d-f27544f97fda", cwd: "/proj" },
    };
    const ref: SessionRef = {
      sourceKind: "codex",
      absolutePath: "/home/user/.codex/sessions/2026/05/25/session.jsonl",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const id = deriveCodexIdentity(ref, firstRecord);
    // A native id that is itself a UUID is reused verbatim.
    expect(id.sessionId).toBe("019e38ab-78b3-7c30-b22d-f27544f97fda");
    expect(id.nativeSessionId).toBe("019e38ab-78b3-7c30-b22d-f27544f97fda");
    expect(id.derivation).toBe("native");
  });

  it("derives a UUID but preserves a non-UUID native id", () => {
    const firstRecord = {
      type: "session_meta",
      payload: { id: "codex-session-abc123", cwd: "/proj" },
    };
    const ref: SessionRef = {
      sourceKind: "codex",
      absolutePath: "/home/user/.codex/sessions/2026/05/25/session.jsonl",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const id = deriveCodexIdentity(ref, firstRecord);
    expect(id.sessionId).toMatch(UUID_RE);
    expect(id.derivation).toBe("path-hash");
    expect(id.nativeSessionId).toBe("codex-session-abc123");
  });

  it("falls back to path hash when first record is not session_meta", () => {
    const firstRecord = { type: "event_msg", payload: {} };
    const ref: SessionRef = {
      sourceKind: "codex",
      absolutePath: "/some/path/session.jsonl",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const id = deriveCodexIdentity(ref, firstRecord);
    expect(id.derivation).toBe("path-hash");
    expect(id.sessionId).toMatch(UUID_RE);
  });

  it("falls back to path hash when first record is null", () => {
    const ref: SessionRef = {
      sourceKind: "codex",
      absolutePath: "/empty/session.jsonl",
      byteSizeOnDisk: 0,
      mtimeMs: 1000,
    };
    const id = deriveCodexIdentity(ref, null);
    expect(id.derivation).toBe("path-hash");
  });

  it("falls back when id is missing from payload", () => {
    const firstRecord = { type: "session_meta", payload: { cwd: "/proj" } };
    const ref: SessionRef = {
      sourceKind: "codex",
      absolutePath: "/path/session.jsonl",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const id = deriveCodexIdentity(ref, firstRecord);
    expect(id.derivation).toBe("path-hash");
  });
});

// ── parse ─────────────────────────────────────────────────────────────────────

describe("parseCodexSession", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), "frugl-codex-parse-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function makeRef(filePath: string): SessionRef {
    return { sourceKind: "codex", absolutePath: filePath, byteSizeOnDisk: 100, mtimeMs: 1000 };
  }

  it("parses typed-event JSONL into records", async () => {
    const filePath = path.join(tempHome, "session.jsonl");
    const lines = [
      '{"type":"session_meta","timestamp":"2026-05-25T10:00:00Z","payload":{"id":"s001","cwd":"/my/project"}}',
      '{"type":"event_msg","timestamp":"2026-05-25T10:00:01Z","payload":{"role":"user","content":"hello"}}',
      '{"type":"event_msg","timestamp":"2026-05-25T10:00:02Z","payload":{"role":"assistant","content":"hi"}}',
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const parsed = await parseCodexSession(makeRef(filePath));
    expect(parsed.sourceKind).toBe("codex");
    expect(parsed.records).toHaveLength(3);
  });

  it("surfaces cwd from session_meta payload", async () => {
    const filePath = path.join(tempHome, "session.jsonl");
    writeFileSync(
      filePath,
      '{"type":"session_meta","timestamp":"2026-05-25T10:00:00Z","payload":{"id":"s001","cwd":"/home/user/projects/myapp"}}\n',
    );

    const parsed = await parseCodexSession(makeRef(filePath));
    expect(parsed.cwd).toBe("/home/user/projects/myapp");
  });

  it("cwd is undefined when session_meta has no cwd", async () => {
    const filePath = path.join(tempHome, "session.jsonl");
    writeFileSync(
      filePath,
      '{"type":"session_meta","timestamp":"2026-05-25T10:00:00Z","payload":{"id":"s001"}}\n',
    );

    const parsed = await parseCodexSession(makeRef(filePath));
    expect(parsed.cwd).toBeUndefined();
  });

  it("wraps malformed lines as _raw", async () => {
    const filePath = path.join(tempHome, "session.jsonl");
    writeFileSync(filePath, '{"type":"session_meta","payload":{"id":"s1"}}\nnot-json\n');

    const parsed = await parseCodexSession(makeRef(filePath));
    expect(parsed.records).toHaveLength(2);
    const raw = parsed.records[1] as { _raw: string };
    expect(raw._raw).toBe("not-json");
  });

  it("identity uses session_meta id when available", async () => {
    const filePath = path.join(tempHome, "session.jsonl");
    writeFileSync(
      filePath,
      '{"type":"session_meta","timestamp":"2026-05-25T10:00:00Z","payload":{"id":"00000000-0000-4000-8000-0000000000c0"}}\n',
    );

    const parsed = await parseCodexSession(makeRef(filePath));
    expect(parsed.identity.sessionId).toBe("00000000-0000-4000-8000-0000000000c0");
    expect(parsed.identity.derivation).toBe("native");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CURSOR_SOURCE_KIND, CURSOR_FORMAT_VERSION, discoverCursorSessions } from "./discover.js";
import { deriveCursorIdentity } from "./identity.js";
import { parseCursorSession } from "./parse.js";
import type { SessionRef } from "../types.js";

// ── discover ────────────────────────────────────────────────────────────────

describe("CURSOR constants", () => {
  it("CURSOR_SOURCE_KIND is cursor", () => {
    expect(CURSOR_SOURCE_KIND).toBe("cursor");
  });

  it("CURSOR_FORMAT_VERSION is cursor-jsonl-2026-05", () => {
    expect(CURSOR_FORMAT_VERSION).toBe("cursor-jsonl-2026-05");
  });
});

describe("discoverCursorSessions", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), "poppi-cursor-discover-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns empty array when cursor projects dir is absent", async () => {
    const refs = await discoverCursorSessions({ homeDir: tempHome });
    expect(refs).toEqual([]);
  });

  it("returns refs for jsonl files under agent-transcripts", async () => {
    const sessionDir = path.join(
      tempHome,
      ".cursor",
      "projects",
      "my-project",
      "agent-transcripts",
      "aaaabbbb-0000-0000-0000-000000000001",
    );
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, "aaaabbbb-0000-0000-0000-000000000002.jsonl"),
      '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n',
    );

    const refs = await discoverCursorSessions({ homeDir: tempHome });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceKind).toBe("cursor");
    expect(refs[0]!.absolutePath).toContain(".jsonl");
    expect(refs[0]!.byteSizeOnDisk).toBeGreaterThan(0);
    expect(refs[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it("ignores non-jsonl files", async () => {
    const sessionDir = path.join(
      tempHome,
      ".cursor",
      "projects",
      "proj",
      "agent-transcripts",
      "sess-uuid",
    );
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, "data.json"), "{}");
    writeFileSync(path.join(sessionDir, "session.jsonl"), '{"role":"user"}\n');

    const refs = await discoverCursorSessions({ homeDir: tempHome });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.absolutePath).toContain("session.jsonl");
  });

  it("returns refs from multiple projects", async () => {
    for (const proj of ["proj-a", "proj-b"]) {
      const dir = path.join(tempHome, ".cursor", "projects", proj, "agent-transcripts", "sess-id");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "session.jsonl"), '{"role":"user"}\n');
    }

    const refs = await discoverCursorSessions({ homeDir: tempHome });
    expect(refs).toHaveLength(2);
  });
});

// ── identity ─────────────────────────────────────────────────────────────────

describe("deriveCursorIdentity", () => {
  it("extracts UUID session dir from agent-transcripts path", () => {
    const ref: SessionRef = {
      sourceKind: "cursor",
      absolutePath:
        "/home/user/.cursor/projects/my-proj/agent-transcripts/aaaabbbb-1111-2222-3333-444444444444/ffffffff-0000-0000-0000-000000000001.jsonl",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const id = deriveCursorIdentity(ref);
    expect(id.sessionId).toBe("aaaabbbb-1111-2222-3333-444444444444");
    expect(id.derivation).toBe("native");
  });

  it("extracts UUID from Windows-style path", () => {
    const ref: SessionRef = {
      sourceKind: "cursor",
      absolutePath:
        "C:\\Users\\user\\.cursor\\projects\\proj\\agent-transcripts\\cccc0000-dddd-1111-eeee-222222222222\\file.jsonl",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const id = deriveCursorIdentity(ref);
    expect(id.sessionId).toBe("cccc0000-dddd-1111-eeee-222222222222");
    expect(id.derivation).toBe("native");
  });

  it("falls back to path hash when agent-transcripts segment is missing", () => {
    const ref: SessionRef = {
      sourceKind: "cursor",
      absolutePath: "/some/other/path/session.jsonl",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const id = deriveCursorIdentity(ref);
    expect(id.derivation).toBe("path-hash");
    expect(id.sessionId).toMatch(/^[0-9a-f]{24}$/);
  });

  it("falls back to path hash when UUID-like segment fails safe validation", () => {
    const ref: SessionRef = {
      sourceKind: "cursor",
      absolutePath: "/home/user/.cursor/projects/proj/agent-transcripts/not a uuid !!!/file.jsonl",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const id = deriveCursorIdentity(ref);
    expect(id.derivation).toBe("path-hash");
  });
});

// ── parse ────────────────────────────────────────────────────────────────────

describe("parseCursorSession", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), "poppi-cursor-parse-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function makeRef(filePath: string): SessionRef {
    return {
      sourceKind: "cursor",
      absolutePath: filePath,
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
  }

  it("returns parsed records from JSONL file", async () => {
    const filePath = path.join(tempHome, "session.jsonl");
    writeFileSync(
      filePath,
      [
        '{"role":"user","message":{"content":[{"type":"text","text":"hello"}]}}',
        '{"role":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      ].join("\n") + "\n",
    );

    const parsed = await parseCursorSession(makeRef(filePath));
    expect(parsed.sourceKind).toBe("cursor");
    expect(parsed.records).toHaveLength(2);
    expect((parsed.records[0] as { role: string }).role).toBe("user");
  });

  it("skips empty lines and wraps malformed lines", async () => {
    const filePath = path.join(tempHome, "session.jsonl");
    writeFileSync(
      filePath,
      ['{"role":"user"}', "", "not-json", '{"role":"assistant"}'].join("\n") + "\n",
    );

    const parsed = await parseCursorSession(makeRef(filePath));
    expect(parsed.records).toHaveLength(3); // 2 valid + 1 malformed
    const malformed = parsed.records[1] as { _raw: string };
    expect(malformed._raw).toBe("not-json");
  });

  it("returns empty records for empty file", async () => {
    const filePath = path.join(tempHome, "empty.jsonl");
    writeFileSync(filePath, "");

    const parsed = await parseCursorSession(makeRef(filePath));
    expect(parsed.records).toHaveLength(0);
  });

  it("cwd is undefined (Cursor sessions have no cwd)", async () => {
    const filePath = path.join(tempHome, "session.jsonl");
    writeFileSync(filePath, '{"role":"user"}\n');

    const parsed = await parseCursorSession(makeRef(filePath));
    expect(parsed.cwd).toBeUndefined();
  });

  it("identity derivation uses path-based UUID extraction", async () => {
    const sessionDir = path.join(tempHome, "agent-transcripts", "my-session-uuid-1234");
    mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, "00000000-0000-0000-0000-000000000001.jsonl");
    writeFileSync(filePath, '{"role":"user"}\n');

    const ref: SessionRef = {
      sourceKind: "cursor",
      absolutePath: filePath,
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const parsed = await parseCursorSession(ref);
    expect(parsed.identity.sessionId).toBe("my-session-uuid-1234");
    expect(parsed.identity.derivation).toBe("native");
  });
});

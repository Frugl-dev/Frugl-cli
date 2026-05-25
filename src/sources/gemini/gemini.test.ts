import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GEMINI_SOURCE_KIND, GEMINI_FORMAT_VERSION, discoverGeminiSessions } from "./discover.js";
import { deriveGeminiIdentity } from "./identity.js";
import { parseGeminiSession } from "./parse.js";
import type { SessionRef } from "../types.js";

// ── discover ─────────────────────────────────────────────────────────────────

describe("GEMINI constants", () => {
  it("GEMINI_SOURCE_KIND is gemini", () => {
    expect(GEMINI_SOURCE_KIND).toBe("gemini");
  });

  it("GEMINI_FORMAT_VERSION is gemini-json-2026-05", () => {
    expect(GEMINI_FORMAT_VERSION).toBe("gemini-json-2026-05");
  });
});

describe("discoverGeminiSessions", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), "poppi-gemini-discover-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns empty array when gemini tmp dir is absent", async () => {
    const refs = await discoverGeminiSessions({ homeDir: tempHome });
    expect(refs).toEqual([]);
  });

  it("returns refs for logs.json files under tmp subdirs", async () => {
    const dir = path.join(tempHome, ".gemini", "tmp", "session-abc123");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "logs.json"),
      '[{"sessionId":"sess-001","messageId":"m-001","type":"user","message":"hi","timestamp":"2026-05-25T10:00:00Z"}]',
    );

    const refs = await discoverGeminiSessions({ homeDir: tempHome });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceKind).toBe("gemini");
    expect(refs[0]!.absolutePath).toContain("logs.json");
    expect(refs[0]!.byteSizeOnDisk).toBeGreaterThan(0);
  });

  it("discovers logs.json from multiple session dirs", async () => {
    for (const sub of ["sess-aaa", "sess-bbb"]) {
      const dir = path.join(tempHome, ".gemini", "tmp", sub);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "logs.json"), "[]");
    }

    const refs = await discoverGeminiSessions({ homeDir: tempHome });
    expect(refs).toHaveLength(2);
  });

  it("ignores files that are not logs.json", async () => {
    const dir = path.join(tempHome, ".gemini", "tmp", "sess-xyz");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "other.json"), "[]");
    writeFileSync(path.join(dir, "logs.json"), "[]");

    const refs = await discoverGeminiSessions({ homeDir: tempHome });
    expect(refs).toHaveLength(1);
  });
});

// ── identity ─────────────────────────────────────────────────────────────────

describe("deriveGeminiIdentity", () => {
  it("extracts sessionId from first array element", () => {
    const ref: SessionRef = {
      sourceKind: "gemini",
      absolutePath: "/home/user/.gemini/tmp/sess-xyz/logs.json",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const firstRecord = {
      sessionId: "00000000-0000-0000-0000-000000000401",
      messageId: "msg-001",
      type: "user",
      message: "hello",
      timestamp: "2026-05-18T12:00:00.000Z",
    };
    const id = deriveGeminiIdentity(ref, firstRecord);
    expect(id.sessionId).toBe("00000000-0000-0000-0000-000000000401");
    expect(id.derivation).toBe("native");
  });

  it("falls back to path hash when first record is null", () => {
    const ref: SessionRef = {
      sourceKind: "gemini",
      absolutePath: "/some/path/logs.json",
      byteSizeOnDisk: 0,
      mtimeMs: 1000,
    };
    const id = deriveGeminiIdentity(ref, null);
    expect(id.derivation).toBe("path-hash");
    expect(id.sessionId).toMatch(/^[0-9a-f]{24}$/);
  });

  it("falls back to path hash when sessionId is missing", () => {
    const ref: SessionRef = {
      sourceKind: "gemini",
      absolutePath: "/path/logs.json",
      byteSizeOnDisk: 100,
      mtimeMs: 1000,
    };
    const id = deriveGeminiIdentity(ref, { messageId: "m-001", type: "user" });
    expect(id.derivation).toBe("path-hash");
  });
});

// ── parse ─────────────────────────────────────────────────────────────────────

describe("parseGeminiSession", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), "poppi-gemini-parse-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function makeRef(filePath: string): SessionRef {
    return { sourceKind: "gemini", absolutePath: filePath, byteSizeOnDisk: 100, mtimeMs: 1000 };
  }

  it("parses JSON array into records", async () => {
    const filePath = path.join(tempHome, "logs.json");
    writeFileSync(
      filePath,
      JSON.stringify([
        {
          sessionId: "sess-001",
          messageId: "m-001",
          type: "user",
          message: "hello",
          timestamp: "2026-05-18T12:00:00.000Z",
        },
        {
          sessionId: "sess-001",
          messageId: "m-002",
          type: "user",
          message: "world",
          timestamp: "2026-05-18T12:01:00.000Z",
        },
      ]),
    );

    const parsed = await parseGeminiSession(makeRef(filePath));
    expect(parsed.sourceKind).toBe("gemini");
    expect(parsed.records).toHaveLength(2);
  });

  it("returns empty records for empty array", async () => {
    const filePath = path.join(tempHome, "logs.json");
    writeFileSync(filePath, "[]");

    const parsed = await parseGeminiSession(makeRef(filePath));
    expect(parsed.records).toHaveLength(0);
  });

  it("cwd is undefined (Gemini sessions have no cwd)", async () => {
    const filePath = path.join(tempHome, "logs.json");
    writeFileSync(filePath, "[]");

    const parsed = await parseGeminiSession(makeRef(filePath));
    expect(parsed.cwd).toBeUndefined();
  });

  it("identity uses sessionId from first record", async () => {
    const filePath = path.join(tempHome, "logs.json");
    writeFileSync(
      filePath,
      JSON.stringify([
        {
          sessionId: "00000000-0000-0000-0000-000000000401",
          messageId: "m-001",
          type: "user",
          message: "hi",
          timestamp: "2026-05-18T12:00:00.000Z",
        },
      ]),
    );

    const parsed = await parseGeminiSession(makeRef(filePath));
    expect(parsed.identity.sessionId).toBe("00000000-0000-0000-0000-000000000401");
    expect(parsed.identity.derivation).toBe("native");
  });

  it("returns path-hash identity for empty array", async () => {
    const filePath = path.join(tempHome, "logs.json");
    writeFileSync(filePath, "[]");

    const parsed = await parseGeminiSession(makeRef(filePath));
    expect(parsed.identity.derivation).toBe("path-hash");
  });
});

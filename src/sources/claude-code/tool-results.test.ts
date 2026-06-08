import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectToolResultRecords, TOOL_RESULT_RECORD_TYPE } from "./tool-results.js";
import { parse } from "../walker.js";
import { claude } from "../descriptor.js";
import { anonymize } from "../../anonymize/index.js";
import type { SessionRef } from "../types.js";

const SESSION_ID = "dc540fc8-3cbf-4fec-90d0-eb72412bd399";
const PLANTED = "SIDE-CAR-PLANTED-SECRET-CONTENT do not upload 4242";

let home: string;
let jsonlPath: string;

function seed(opts: { sidecars?: Record<string, string>; transcript?: string } = {}): void {
  const projectDir = path.join(home, ".claude", "projects", "-Users-test-proj");
  mkdirSync(projectDir, { recursive: true });
  jsonlPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
  writeFileSync(
    jsonlPath,
    opts.transcript ??
      `${JSON.stringify({ sessionId: SESSION_ID, type: "user", cwd: "/Users/test/proj", message: { role: "user", content: "hi" } })}\n`,
  );
  if (opts.sidecars) {
    const dir = path.join(projectDir, SESSION_ID, "tool-results");
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(opts.sidecars)) {
      writeFileSync(path.join(dir, name), content);
    }
  }
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "frugl-tool-results-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("collectToolResultRecords", () => {
  it("emits one metadata record per sidecar file, name-sorted", async () => {
    seed({ sidecars: { "zzz.txt": "b".repeat(20), "aaa.txt": "a".repeat(40) } });
    const { records, warnings } = await collectToolResultRecords(jsonlPath);
    expect(warnings).toEqual([]);
    expect(records).toEqual([
      { type: TOOL_RESULT_RECORD_TYPE, schema: 1, file_id: "aaa", bytes: 40, chars: 40 },
      { type: TOOL_RESULT_RECORD_TYPE, schema: 1, file_id: "zzz", bytes: 20, chars: 20 },
    ]);
  });

  it("counts UTF-8 characters, not bytes", async () => {
    // "é" is 2 bytes, 1 char.
    seed({ sidecars: { "uni.txt": "é".repeat(10) } });
    const { records } = await collectToolResultRecords(jsonlPath);
    expect(records[0]).toMatchObject({ bytes: 20, chars: 10 });
  });

  it("returns empty with no warnings when the sidecar dir is missing (normal case)", async () => {
    seed();
    const { records, warnings } = await collectToolResultRecords(jsonlPath);
    expect(records).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("ignores non-.txt entries", async () => {
    seed({ sidecars: { "keep.txt": "x", "skip.json": "{}", "skip.txt.bak": "x" } });
    const { records } = await collectToolResultRecords(jsonlPath);
    expect(records.map((r) => r.file_id)).toEqual(["keep"]);
  });

  it("skips an unreadable file with a warning and keeps the rest", async () => {
    seed({ sidecars: { "good.txt": "ok", "locked.txt": "nope" } });
    chmodSync(path.join(path.dirname(jsonlPath), SESSION_ID, "tool-results", "locked.txt"), 0o000);
    const { records, warnings } = await collectToolResultRecords(jsonlPath);
    expect(records.map((r) => r.file_id)).toEqual(["good"]);
    expect(warnings).toEqual(["skipped unreadable tool-result file: locked.txt"]);
  });

  it("emits exactly the five allowlisted keys per record (fail-closed shape)", async () => {
    seed({ sidecars: { "a.txt": PLANTED } });
    const { records } = await collectToolResultRecords(jsonlPath);
    expect(Object.keys(records[0]!).toSorted()).toEqual([
      "bytes",
      "chars",
      "file_id",
      "schema",
      "type",
    ]);
  });
});

describe("spec 039 — sidecar records through parse + anonymize (fail-closed)", () => {
  const refOf = (): SessionRef => ({
    sourceKind: "claude-code",
    absolutePath: jsonlPath,
    byteSizeOnDisk: 100,
    mtimeMs: 1,
  });

  it("appends records after the transcript lines via the claude descriptor", async () => {
    seed({ sidecars: { "a.txt": "x".repeat(400) } });
    const parsed = await parse(claude, refOf());
    const last = parsed.records[parsed.records.length - 1] as Record<string, unknown>;
    expect(last.type).toBe(TOOL_RESULT_RECORD_TYPE);
    expect(last.chars).toBe(400);
    // Transcript record still first — identity extraction is unaffected.
    expect(parsed.identity.nativeSessionId).toBe(SESSION_ID);
  });

  it("warns (without aborting) when a sidecar file is unreadable", async () => {
    seed({ sidecars: { "locked.txt": "nope" } });
    chmodSync(path.join(path.dirname(jsonlPath), SESSION_ID, "tool-results", "locked.txt"), 0o000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = await parse(claude, refOf());
    expect(parsed.records.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipped unreadable tool-result file: locked.txt"),
    );
  });

  it("never lets sidecar file content reach the anonymized upload payload", async () => {
    seed({ sidecars: { "a.txt": PLANTED, "b.txt": `prefix ${PLANTED} suffix` } });
    const parsed = await parse(claude, refOf());
    const result = anonymize(parsed.records, {
      uploadId: "test-upload",
      ownerEmail: "owner@example.com",
      homeDir: home,
    });
    const payloadJson = JSON.stringify(result.payload);
    expect(payloadJson).not.toContain(PLANTED);
    expect(payloadJson).not.toContain("PLANTED-SECRET");
    // The metadata records themselves survive anonymization with their
    // numeric size fields intact.
    const records = result.payload as Record<string, unknown>[];
    const sidecars = records.filter((r) => r.type === TOOL_RESULT_RECORD_TYPE);
    expect(sidecars).toHaveLength(2);
    expect(sidecars.map((r) => r.chars)).toEqual([PLANTED.length, PLANTED.length + 14]);
  });

  it("changes the content hash when sidecar files appear (re-upload trigger)", async () => {
    seed();
    const before = anonymize((await parse(claude, refOf())).records, {
      uploadId: "u1",
      ownerEmail: "owner@example.com",
      homeDir: home,
    });
    const dir = path.join(path.dirname(jsonlPath), SESSION_ID, "tool-results");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "new.txt"), "fresh output");
    const after = anonymize((await parse(claude, refOf())).records, {
      uploadId: "u1",
      ownerEmail: "owner@example.com",
      homeDir: home,
    });
    expect(after.contentHashHex).not.toBe(before.contentHashHex);
  });
});

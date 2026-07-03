import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { anonymize } from "../anonymize/index.js";
import { cursor } from "./descriptor.js";
import { discover, parse, probe, toSource } from "./walker.js";
import {
  composerIdOf,
  decodeCursorComposer,
  discoverCursorComposers,
  isComposerRef,
  vscdbFilePath,
  type CursorComposerExport,
} from "./cursor-vscdb.js";

// ── synthetic state.vscdb builder ────────────────────────────────────────────────
//
// On THIS dev machine the live Cursor composers are all empty and blob-encrypted,
// so we cannot validate against real data. These tests build a tiny SQLite store
// to the documented `cursorDiskKV` schema (composerData:* + bubbleId:* rows) and
// assert extraction against it.

interface SeedBubble {
  bubbleId: string;
  type: number;
  text: string;
  // Extra raw fields merged into the stored bubble JSON (tokenCount, modelInfo,
  // toolFormerData, …) to exercise the telemetry passthrough.
  extras?: Record<string, unknown>;
}
interface SeedComposer {
  composerId: string;
  name?: string;
  workspaceName?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  modelName?: string;
  usageData?: Record<string, unknown>;
  bubbles: SeedBubble[];
  // When true, write the composerData row with empty headers + no bubble rows.
  empty?: boolean;
}

function seedVscdb(file: string, composers: SeedComposer[]): void {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const c of composers) {
    const headers = c.empty ? [] : c.bubbles.map((b) => ({ bubbleId: b.bubbleId, type: b.type }));
    const composerData: Record<string, unknown> = {
      composerId: c.composerId,
      fullConversationHeadersOnly: headers,
    };
    if (c.name !== undefined) composerData.name = c.name;
    if (c.workspaceName !== undefined) composerData.workspaceName = c.workspaceName;
    if (c.createdAt !== undefined) composerData.createdAt = c.createdAt;
    if (c.lastUpdatedAt !== undefined) composerData.lastUpdatedAt = c.lastUpdatedAt;
    if (c.modelName !== undefined) composerData.modelConfig = { modelName: c.modelName };
    if (c.usageData !== undefined) composerData.usageData = c.usageData;
    put.run(`composerData:${c.composerId}`, JSON.stringify(composerData));
    if (!c.empty) {
      for (const b of c.bubbles) {
        put.run(
          `bubbleId:${c.composerId}:${b.bubbleId}`,
          JSON.stringify({ type: b.type, text: b.text, ...b.extras }),
        );
      }
    }
  }
  db.close();
}

// Write a global state.vscdb under a fake home matching the macOS layout.
function seedGlobalStore(home: string, composers: SeedComposer[]): string {
  const dir = path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "state.vscdb");
  seedVscdb(file, composers);
  return file;
}

const C1 = "aaaaaaaa-1111-2222-3333-444444444444";
const C2 = "bbbbbbbb-5555-6666-7777-888888888888";
const EMPTY = "cccccccc-9999-0000-1111-222222222222";

describe("cursor-vscdb path helpers", () => {
  it("encodes/strips the composer marker so each composer gets a unique path", () => {
    const ref = `/some/state.vscdb::composer::${C1}`;
    expect(isComposerRef(ref)).toBe(true);
    expect(vscdbFilePath(ref)).toBe("/some/state.vscdb");
    expect(composerIdOf(ref)).toBe(C1);
  });

  it("passes a plain file path through unchanged", () => {
    expect(isComposerRef("/x/state.vscdb")).toBe(false);
    expect(vscdbFilePath("/x/state.vscdb")).toBe("/x/state.vscdb");
    expect(composerIdOf("/x/state.vscdb")).toBeUndefined();
  });
});

describe("discoverCursorComposers + decodeCursorComposer", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-cursor-vscdb-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns [] when no Cursor store exists", async () => {
    expect(await discoverCursorComposers({ homeDir: home })).toEqual([]);
  });

  it("returns [] for an empty/placeholder state.vscdb (no cursorDiskKV table)", async () => {
    const dir = path.join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
    );
    mkdirSync(dir, { recursive: true });
    // An empty file is a valid (openable) but table-less SQLite store — the
    // common shape on a fresh install. Honest skip, never an error.
    writeFileSync(path.join(dir, "state.vscdb"), "");
    expect(await discoverCursorComposers({ homeDir: home })).toEqual([]);
  });

  it("discovers one ref per non-empty composer and skips empty composers", async () => {
    seedGlobalStore(home, [
      {
        composerId: C1,
        name: "Fix editor height",
        createdAt: 1,
        lastUpdatedAt: 2,
        bubbles: [
          { bubbleId: "b1", type: 1, text: "hello" },
          { bubbleId: "b2", type: 2, text: "world" },
        ],
      },
      { composerId: EMPTY, empty: true, bubbles: [] },
    ]);

    const refs = await discoverCursorComposers({ homeDir: home });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceKind).toBe("cursor");
    expect(composerIdOf(refs[0]!.absolutePath)).toBe(C1);
    expect(refs[0]!.byteSizeOnDisk).toBeGreaterThan(0);
  });

  it("decodes a composer into the {composer, bubbles} export shape the cloud expects", async () => {
    seedGlobalStore(home, [
      {
        composerId: C1,
        name: "Fix editor height",
        workspaceName: "my-project",
        createdAt: 1775528454034,
        lastUpdatedAt: 1775528520000,
        modelName: "claude-4.5-sonnet",
        usageData: { inputTokens: 100, outputTokens: 20 },
        bubbles: [
          { bubbleId: "b1", type: 1, text: "the editor pane is collapsed" },
          { bubbleId: "b2", type: 2, text: "I set the container to flex-1" },
        ],
      },
    ]);

    const refs = await discoverCursorComposers({ homeDir: home });
    const records = await decodeCursorComposer(refs[0]!);
    expect(records).toHaveLength(1);
    const exp = records[0] as CursorComposerExport;
    expect(exp.composer.composerId).toBe(C1);
    expect(exp.composer.name).toBe("Fix editor height");
    expect(exp.composer.workspaceName).toBe("my-project");
    expect(exp.composer.modelConfig).toEqual({ modelName: "claude-4.5-sonnet" });
    expect(exp.composer.usageData).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(exp.composer.fullConversationHeadersOnly).toEqual([
      { bubbleId: "b1", type: 1 },
      { bubbleId: "b2", type: 2 },
    ]);
    expect(exp.bubbles.b1!.text).toBe("the editor pane is collapsed");
    expect(exp.bubbles.b2!.text).toBe("I set the container to flex-1");
  });

  it("omits modelConfig/usageData when the composer recorded neither (honest absence)", async () => {
    seedGlobalStore(home, [{ composerId: C1, bubbles: [{ bubbleId: "b1", type: 1, text: "hi" }] }]);
    const refs = await discoverCursorComposers({ homeDir: home });
    const exp = (await decodeCursorComposer(refs[0]!))[0] as CursorComposerExport;
    expect(exp.composer.modelConfig).toBeUndefined();
    expect(exp.composer.usageData).toBeUndefined();
  });
});

// ── through the descriptor/walker seam (identity + decode override) ─────────────

describe("cursor descriptor via walker (vscdb override)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-cursor-walker-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("probes installed once the global store exists", async () => {
    expect(await probe(cursor, { homeDir: home })).toBe(false);
    seedGlobalStore(home, [{ composerId: C1, bubbles: [{ bubbleId: "b1", type: 1, text: "hi" }] }]);
    expect(await probe(cursor, { homeDir: home })).toBe(true);
  });

  it("discover → parse reuses the composerId as the (UUID) session id", async () => {
    seedGlobalStore(home, [
      { composerId: C1, bubbles: [{ bubbleId: "b1", type: 1, text: "hi" }] },
      { composerId: C2, bubbles: [{ bubbleId: "b1", type: 1, text: "yo" }] },
    ]);
    const refs = await discover(cursor, { homeDir: home });
    expect(refs).toHaveLength(2);

    const parsed = await parse(cursor, refs[0]!);
    expect(parsed.sourceKind).toBe("cursor");
    expect(parsed.records).toHaveLength(1);
    // composerId is a UUID → reused natively, distinct per composer.
    expect([C1, C2]).toContain(parsed.identity.sessionId);
    expect(parsed.identity.derivation).toBe("native");

    const source = toSource(cursor);
    const reDerived = source.deriveIdentity(refs[0]!, parsed);
    expect(reDerived.sessionId).toBe(parsed.identity.sessionId);
  });

  it("groups every IDE composer under a single 'cursor' project", () => {
    const refs = [
      {
        sourceKind: "cursor",
        absolutePath: `/h/state.vscdb::composer::${C1}`,
        byteSizeOnDisk: 1,
        mtimeMs: 1,
      },
      {
        sourceKind: "cursor",
        absolutePath: `/h/state.vscdb::composer::${C2}`,
        byteSizeOnDisk: 1,
        mtimeMs: 1,
      },
    ];
    const groups = cursor.deriveProjects(refs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.projectId).toBe("cursor");
    expect(groups[0]!.sessionCount).toBe(2);
  });
});

// ── ANONYMIZATION (load-bearing): bubble text + composer name must be redacted ──

describe("cursor vscdb export is anonymized like every other provider", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-cursor-anon-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("redacts a third-party email in bubble text and composer name", async () => {
    const planted = "someone-else@example.com";
    seedGlobalStore(home, [
      {
        composerId: C1,
        name: `thread about ${planted}`,
        bubbles: [
          { bubbleId: "b1", type: 1, text: `please email ${planted} about the bug` },
          { bubbleId: "b2", type: 2, text: "sure, drafting now" },
        ],
      },
    ]);

    const refs = await discover(cursor, { homeDir: home });
    const parsed = await parse(cursor, refs[0]!);

    // This is exactly the input the upload pipeline anonymizes (classify.ts
    // calls anonymize(parsed.records, ...)).
    const result = anonymize(parsed.records, {
      uploadId: "11111111-1111-1111-1111-111111111111",
      ownerEmail: "owner@example.com",
    });

    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain(planted);
    // A redaction was actually applied (fail-closed would otherwise throw).
    expect(result.redactionsByCategory["third-party-email"]).toBeGreaterThan(0);
  });
});

describe("per-bubble telemetry passthrough (tokenCount / modelInfo / toolFormerData)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-cursor-telemetry-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("exports tokenCount, modelInfo, and size-only toolCalls — never the result body", async () => {
    seedGlobalStore(home, [
      {
        composerId: C1,
        name: "telemetry",
        bubbles: [
          { bubbleId: "b1", type: 1, text: "run the tests" },
          {
            bubbleId: "b2",
            type: 2,
            text: "Running.",
            extras: {
              tokenCount: { inputTokens: 5200, outputTokens: 310 },
              modelInfo: { modelName: "composer-2.5" },
              toolFormerData: {
                name: "run_terminal_command_v2",
                status: "completed",
                result: "SECRET-LADEN 13kb output that must never leave the machine",
              },
            },
          },
        ],
      },
    ]);
    const refs = await discoverCursorComposers({ homeDir: home });
    expect(refs).toHaveLength(1);
    const records = await decodeCursorComposer(refs[0]!);
    const exp = records[0] as CursorComposerExport;
    const b2 = exp.bubbles.b2!;
    expect(b2.tokenCount).toEqual({ inputTokens: 5200, outputTokens: 310 });
    expect(b2.modelInfo).toEqual({ modelName: "composer-2.5" });
    expect(b2.toolCalls).toEqual([
      { name: "run_terminal_command_v2", status: "completed", resultChars: 58 },
    ]);
    // The raw result body never appears anywhere in the export.
    expect(JSON.stringify(exp)).not.toContain("SECRET-LADEN");
  });

  it("omits telemetry fields entirely when the store never recorded them", async () => {
    seedGlobalStore(home, [{ composerId: C2, bubbles: [{ bubbleId: "b1", type: 1, text: "hi" }] }]);
    const refs = await discoverCursorComposers({ homeDir: home });
    const records = await decodeCursorComposer(refs[0]!);
    const exp = records[0] as CursorComposerExport;
    expect(exp.bubbles.b1).toEqual({ type: 1, text: "hi" });
  });
});

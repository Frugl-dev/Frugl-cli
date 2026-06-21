import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { anonymize } from "../anonymize/index.js";
import { cursor } from "./descriptor.js";
import { discover, parse, probe, toSource } from "./walker.js";
import {
  agentTranscriptId,
  agentTranscriptToExport,
  cursorInstalled,
  decodeAgentTranscriptCwd,
  decodeCursorAgentTranscript,
  discoverCursorAgentTranscripts,
  isAgentTranscriptRef,
} from "./cursor-agent.js";
import type { CursorComposerExport } from "./cursor-vscdb.js";

// cursor-agent terminal transcripts live at
//   ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
// These tests build a tiny one to the observed on-disk shape and assert the
// conversion into the cloud Cursor adapter's {composer, bubbles} export.

const SID = "b74a436c-a85d-45ad-9813-be400a512c11";

// One realistic transcript: a user query, an assistant turn mixing text +
// tool_use, a turn_ended marker, then a second exchange.
function transcriptLines(): string {
  return [
    { role: "user", message: { content: [{ type: "text", text: "Review @PRE-RELEASE.md" }] } },
    {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Reviewing the diff." },
          {
            type: "tool_use",
            name: "Shell",
            input: {
              command: "git diff PRE-RELEASE.md",
              working_directory: "/Users/dev/Documents/Projects/Frugl",
            },
          },
        ],
      },
    },
    { type: "turn_ended", status: "success" },
    { role: "user", message: { content: [{ type: "text", text: "Fix the checkboxes" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
}

// Write a transcript under a fake home matching the cursor-agent layout. The
// `encodedCwd` is the dir name cursor-agent derives from the session's cwd.
function seedTranscript(home: string, encodedCwd: string, sessionId: string): string {
  const dir = path.join(home, ".cursor", "projects", encodedCwd, "agent-transcripts", sessionId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, transcriptLines());
  return file;
}

describe("cursor-agent path helpers", () => {
  const p = `/h/.cursor/projects/Users-dev-Documents-Projects-Frugl/agent-transcripts/${SID}/${SID}.jsonl`;

  it("recognizes a transcript ref and ignores a vscdb composer ref", () => {
    expect(isAgentTranscriptRef(p)).toBe(true);
    expect(isAgentTranscriptRef(`/h/state.vscdb::composer::${SID}`)).toBe(false);
  });

  it("reads the sessionId from the dir after /agent-transcripts/", () => {
    expect(agentTranscriptId(p)).toBe(SID);
    expect(agentTranscriptId("/h/state.vscdb")).toBeUndefined();
  });

  it("decodes the cwd from the projects/<encoded> segment", () => {
    expect(decodeAgentTranscriptCwd(p)).toBe("/Users/dev/Documents/Projects/Frugl");
    expect(decodeAgentTranscriptCwd("/h/state.vscdb")).toBeUndefined();
  });
});

describe("agentTranscriptToExport", () => {
  it("converts a flat transcript into the {composer, bubbles} shape", () => {
    const records = transcriptLines()
      .split("\n")
      .map((l) => JSON.parse(l));
    const exp = agentTranscriptToExport(records, SID);
    expect(exp).not.toBeNull();
    // turn_ended is dropped; 4 role-bearing turns remain.
    expect(exp!.composer.composerId).toBe(SID);
    expect(exp!.composer.fullConversationHeadersOnly).toEqual([
      { bubbleId: "b0", type: 1 },
      { bubbleId: "b1", type: 2 },
      { bubbleId: "b2", type: 1 },
      { bubbleId: "b3", type: 2 },
    ]);
    expect(exp!.bubbles.b0!.text).toBe("Review @PRE-RELEASE.md");
    // tool_use parts carry no text → only the text part survives (Cursor's
    // documented tool-detail ceiling).
    expect(exp!.bubbles.b1!.text).toBe("Reviewing the diff.");
    expect(exp!.bubbles.b3!.text).toBe("Done.");
  });

  it("returns null when no user/assistant turn is present", () => {
    const records = [{ type: "turn_ended", status: "success" }, { foo: "bar" }];
    expect(agentTranscriptToExport(records, SID)).toBeNull();
  });
});

describe("discover + decode through the cursor descriptor", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-cursor-agent-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns [] when no ~/.cursor/projects exists", async () => {
    expect(await discoverCursorAgentTranscripts({ homeDir: home })).toEqual([]);
  });

  it("discovers one ref per transcript file", async () => {
    seedTranscript(home, "Users-dev-Documents-Projects-Frugl", SID);
    const refs = await discoverCursorAgentTranscripts({ homeDir: home });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceKind).toBe("cursor");
    expect(isAgentTranscriptRef(refs[0]!.absolutePath)).toBe(true);
    expect(agentTranscriptId(refs[0]!.absolutePath)).toBe(SID);
  });

  it("decodes a transcript ref into the export the cloud adapter expects", async () => {
    seedTranscript(home, "Users-dev-Documents-Projects-Frugl", SID);
    const [ref] = await discoverCursorAgentTranscripts({ homeDir: home });
    const records = await decodeCursorAgentTranscript(ref!);
    expect(records).toHaveLength(1);
    const exp = records[0] as CursorComposerExport;
    expect(exp.composer.composerId).toBe(SID);
    expect(exp.composer.fullConversationHeadersOnly).toHaveLength(4);
  });

  it("walker discover surfaces BOTH transcripts and vscdb composers as cursor refs", async () => {
    seedTranscript(home, "Users-dev-Documents-Projects-Frugl", SID);
    // No vscdb seeded → only the transcript is found, proving the transcript
    // source runs even with an empty/absent IDE store (terminal-only user).
    const refs = await discover(cursor, { homeDir: home });
    expect(refs).toHaveLength(1);
    expect(agentTranscriptId(refs[0]!.absolutePath)).toBe(SID);
  });

  it("parse reuses the transcript sessionId (UUID) as the session id", async () => {
    seedTranscript(home, "Users-dev-Documents-Projects-Frugl", SID);
    const refs = await discover(cursor, { homeDir: home });
    const parsed = await parse(cursor, refs[0]!);
    expect(parsed.sourceKind).toBe("cursor");
    expect(parsed.identity.sessionId).toBe(SID);
    expect(parsed.identity.derivation).toBe("native");

    const reDerived = toSource(cursor).deriveIdentity(refs[0]!, parsed);
    expect(reDerived.sessionId).toBe(SID);
  });

  it("attaches the path-decoded cwd so the git resolver can attribute a branch", async () => {
    seedTranscript(home, "Users-dev-Documents-Projects-Frugl", SID);
    const refs = await discover(cursor, { homeDir: home });
    const parsed = await parse(cursor, refs[0]!);
    expect(parsed.cwd).toBe("/Users/dev/Documents/Projects/Frugl");
  });
});

describe("cursor probe (installed = IDE store OR cursor-agent transcripts)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-cursor-probe-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("is false when neither source exists", async () => {
    expect(await cursorInstalled({ homeDir: home })).toBe(false);
    expect(await probe(cursor, { homeDir: home })).toBe(false);
  });

  it("is true for a terminal-only user (transcripts, no IDE store)", async () => {
    seedTranscript(home, "Users-dev-Documents-Projects-Frugl", SID);
    expect(await cursorInstalled({ homeDir: home })).toBe(true);
    // The descriptor's custom probe must agree — this is what lets upload.ts
    // detect Cursor for a user who never opened the IDE.
    expect(await probe(cursor, { homeDir: home })).toBe(true);
  });

  it("is true when only the IDE global store exists (no transcripts)", async () => {
    const dir = path.join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "state.vscdb"), "");
    expect(await cursorInstalled({ homeDir: home })).toBe(true);
    expect(await probe(cursor, { homeDir: home })).toBe(true);
  });
});

// ── ANONYMIZATION (load-bearing): transcript bubble text must be redacted ──────

describe("cursor-agent transcript export is anonymized like every other provider", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-cursor-agent-anon-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("redacts a third-party email planted in a turn", async () => {
    const planted = "someone-else@example.com";
    const dir = path.join(
      home,
      ".cursor",
      "projects",
      "Users-dev-Documents-Projects-Frugl",
      "agent-transcripts",
      SID,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${SID}.jsonl`),
      [
        { role: "user", message: { content: [{ type: "text", text: `email ${planted}` }] } },
        { role: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );

    const refs = await discover(cursor, { homeDir: home });
    const parsed = await parse(cursor, refs[0]!);
    const result = anonymize(parsed.records, {
      uploadId: "11111111-1111-1111-1111-111111111111",
      ownerEmail: "owner@example.com",
    });

    expect(JSON.stringify(result.payload)).not.toContain(planted);
    expect(result.redactionsByCategory["third-party-email"]).toBeGreaterThan(0);
  });
});

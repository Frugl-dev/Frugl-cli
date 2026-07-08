import { describe, expect, it } from "vitest";
import { explainEmptySelection, explainNoProvidersSelected } from "./upload.js";
import type { DetectedProvider, ProjectGroup } from "../sources/providers.js";
import type { SessionClassification } from "../ledger/classify.js";
import type { SessionRef } from "../sources/types.js";
import { nowIso } from "../lib/time.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function detected(displayName: string): DetectedProvider {
  return { descriptor: { displayName } as DetectedProvider["descriptor"] };
}

function group(sessionCount: number, displayName = "/Users/me/proj"): ProjectGroup {
  return {
    providerId: "claude",
    projectId: displayName,
    displayName,
    sessions: [],
    sessionCount,
  };
}

function ref(p: string): SessionRef {
  return { sourceKind: "claude-code", absolutePath: p, byteSizeOnDisk: 100, mtimeMs: 1 };
}

function assistantRecord(model: string, usage: Record<string, number>): unknown {
  return { message: { role: "assistant", model, usage } };
}

// A costed, brand-new session (well over the $0.01 exclude floor).
function newItem(p: string): SessionClassification {
  return {
    kind: "new",
    ref: ref(p),
    identity: { sessionId: p, derivation: "native" },
    anonymizationResult: { contentHashHex: "abc", byteSize: 10, redactionsByCategory: {} } as any,
    parsed: {
      sourceKind: "claude-code",
      ref: ref(p),
      identity: { sessionId: p, derivation: "native" },
      records: [
        assistantRecord("claude-opus-4-8", { input_tokens: 100_000, output_tokens: 50_000 }),
      ],
    } as any,
  };
}

// An already-uploaded session (unchanged since last run).
function unchangedItem(p: string): SessionClassification {
  return {
    kind: "unchanged",
    ref: ref(p),
    identity: { sessionId: p, derivation: "native" },
    ledgerEntry: {
      sessionId: p,
      contentHash: "y".repeat(64),
      lastUploadedAt: nowIso(),
      manifestId: "m1",
    },
  };
}

// ── explainNoProvidersSelected ───────────────────────────────────────────────

describe("explainNoProvidersSelected", () => {
  it("names the providers that were detected but left unchecked", () => {
    const out = explainNoProvidersSelected([detected("Claude Code"), detected("Codex")]);
    expect(out.reason.kind).toBe("no_providers_selected");
    expect(out.reason.providersDetected).toEqual(["Claude Code", "Codex"]);
    expect(out.human).toContain("Claude Code");
    expect(out.human).toContain("Codex");
    // Not the opaque old "Nothing selected."
    expect(out.human).not.toBe("Nothing selected.");
  });
});

// ── explainEmptySelection ────────────────────────────────────────────────────

describe("explainEmptySelection", () => {
  it("no session files discovered → no_sessions_discovered", () => {
    const out = explainEmptySelection({
      groups: [group(0)],
      classifications: [],
      scopeDir: null,
      minCostUsd: 10,
    });
    expect(out.reason.kind).toBe("no_sessions_discovered");
    expect(out.human).not.toBe("Nothing selected.");
  });

  it("sessions exist but a .frugl.json scopes the run elsewhere → outside_project_scope", () => {
    // The real-world hit: a bare `frugl upload` from a freshly-`init`ed directory
    // whose own sessions live under a different project path.
    const scopeDir = "/Users/me/fresh-project";
    const out = explainEmptySelection({
      groups: [group(3, "/Users/me/other-project")],
      classifications: [],
      scopeDir,
      minCostUsd: 10,
    });
    expect(out.reason.kind).toBe("outside_project_scope");
    expect(out.reason.scopeDir).toBe(scopeDir);
    expect(out.reason.sessionsDiscovered).toBe(3);
    expect(out.human).toContain(scopeDir);
  });

  it("everything already uploaded → nothing_left_after_filters with the count", () => {
    const classifications = [unchangedItem("/a/1.jsonl"), unchangedItem("/a/2.jsonl")];
    const out = explainEmptySelection({
      groups: [group(2)],
      classifications,
      scopeDir: null,
      minCostUsd: 10,
    });
    expect(out.reason.kind).toBe("nothing_left_after_filters");
    expect(out.reason.alreadyUploaded).toBe(2);
    expect(out.human).toContain("already uploaded");
  });

  it("a new costed session left unchecked → counted as unselected, not filtered", () => {
    const out = explainEmptySelection({
      groups: [group(1)],
      classifications: [newItem("/a/1.jsonl")],
      scopeDir: null,
      minCostUsd: 10,
    });
    expect(out.reason.kind).toBe("nothing_left_after_filters");
    expect(out.reason.alreadyUploaded).toBe(0);
    expect(out.reason.unselected).toBe(1);
  });
});

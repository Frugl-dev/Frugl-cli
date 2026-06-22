import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claude,
  codex,
  cursor,
  DESCRIPTORS,
  firstNonEmpty,
  gemini,
  getDescriptor,
  readStr,
  segmentAfter,
  type ExtractContext,
} from "./descriptor.js";
import type { SessionRef } from "./types.js";

// A SessionRef with a given path; the other fields are irrelevant to the pure
// extractors but required by the type.
function refAt(absolutePath: string): SessionRef {
  return { sourceKind: "x", absolutePath, byteSizeOnDisk: 0, mtimeMs: 0 };
}

// An ExtractContext from a path + records (firstRecord derived like the walker).
function ctx(absolutePath: string, records: unknown[] = []): ExtractContext {
  return { ref: refAt(absolutePath), records, firstRecord: records[0] ?? null };
}

describe("shared pure helpers", () => {
  describe("readStr", () => {
    it("returns a non-empty string property", () => {
      expect(readStr({ k: "v" }, "k")).toBe("v");
    });
    it("returns undefined for empty string, wrong type, missing key, or non-object", () => {
      expect(readStr({ k: "" }, "k")).toBeUndefined();
      expect(readStr({ k: 7 }, "k")).toBeUndefined();
      expect(readStr({ other: "v" }, "k")).toBeUndefined();
      expect(readStr(null, "k")).toBeUndefined();
      expect(readStr("string", "k")).toBeUndefined();
    });
  });

  describe("firstNonEmpty", () => {
    it("returns the first record carrying a non-empty value for the key", () => {
      const records = [{}, { cwd: "" }, { cwd: "/a" }, { cwd: "/b" }];
      expect(firstNonEmpty(records, "cwd")).toBe("/a");
    });
    it("returns undefined when no record has the key", () => {
      expect(firstNonEmpty([{}, { other: "x" }], "cwd")).toBeUndefined();
      expect(firstNonEmpty([], "cwd")).toBeUndefined();
    });
  });

  describe("segmentAfter", () => {
    it("returns the first segment after the marker (separator-agnostic)", () => {
      expect(segmentAfter("/a/projects/proj-1/file.jsonl", "/projects/")).toBe("proj-1");
      // Backslashes are normalized to forward slashes first.
      expect(segmentAfter("C:\\a\\projects\\proj-2\\f", "/projects/")).toBe("proj-2");
    });
    it("uses the LAST occurrence of the marker", () => {
      expect(segmentAfter("/projects/a/projects/b/x", "/projects/")).toBe("b");
    });
    it("returns undefined when marker is absent or nothing follows it", () => {
      expect(segmentAfter("/a/b/c", "/projects/")).toBeUndefined();
      expect(segmentAfter("/a/projects/", "/projects/")).toBeUndefined();
    });
  });
});

describe("DESCRIPTORS registry", () => {
  it("contains the four providers in order", () => {
    expect(DESCRIPTORS.map((d) => d.id)).toEqual(["claude", "codex", "cursor", "gemini"]);
  });

  it("getDescriptor returns the matching descriptor and throws on unknown", () => {
    expect(getDescriptor("codex")).toBe(codex);
    // @ts-expect-error — deliberately unknown id to exercise the throw path.
    expect(() => getDescriptor("nope")).toThrow(/unknown provider descriptor: nope/);
  });

  it("every descriptor carries the wire-stable metadata invariants", () => {
    const expected = {
      claude: { sourceKind: "claude-code", displayName: "Claude Code" },
      codex: { sourceKind: "codex", displayName: "Codex (beta)" },
      cursor: { sourceKind: "cursor", displayName: "Cursor (beta)" },
      gemini: { sourceKind: "gemini", displayName: "Gemini (beta)" },
    } as const;
    for (const d of DESCRIPTORS) {
      expect(d.sourceKind).toBe(expected[d.id].sourceKind);
      expect(d.displayName).toBe(expected[d.id].displayName);
      expect(d.formatVersion).toMatch(new RegExp(`^${d.id === "claude" ? "claude" : d.id}-`));
    }
  });
});

describe("claude descriptor extractors", () => {
  it("extractNativeId reads sessionId off the first record", () => {
    expect(claude.extractNativeId(ctx("/p", [{ sessionId: "uuid-1" }, {}]))).toBe("uuid-1");
    expect(claude.extractNativeId(ctx("/p", [{}]))).toBeUndefined();
  });

  it("allowNativeReuse is true for a main checkout, false for a worktree copy", () => {
    // A plain projects path has no worktree marker → reuse allowed.
    const main = "/home/.claude/projects/-Users-me-repo/abc.jsonl";
    expect(claude.allowNativeReuse?.(ctx(main))).toBe(true);
    // A worktree-encoded path carries the "--claude-worktrees-" marker → the
    // native id is NOT reused (a path-derived id is used so worktree copies that
    // share a native UUID never collide on the cloud's primary key).
    const worktree = "/home/.claude/projects/-Users-me-repo--claude-worktrees-feature/abc.jsonl";
    expect(claude.allowNativeReuse?.(ctx(worktree))).toBe(false);
  });

  it("extractMetadata surfaces the first cwd and gitBranch across records", () => {
    const records = [{ cwd: "/repo", gitBranch: "" }, { gitBranch: "main" }];
    expect(claude.extractMetadata?.(ctx("/p", records))).toEqual({
      cwd: "/repo",
      recordedBranch: "main",
    });
  });

  it("extractMetadata yields undefined fields when absent (honest absence)", () => {
    expect(claude.extractMetadata?.(ctx("/p", [{}]))).toEqual({
      cwd: undefined,
      recordedBranch: undefined,
    });
  });
});

// A codex session_meta record wrapping a payload.
function meta(payload: Record<string, unknown>) {
  return { type: "session_meta", payload };
}

describe("codex descriptor extractors", () => {
  it("extractNativeId reads payload.id only under a session_meta record", () => {
    expect(codex.extractNativeId(ctx("/p", [meta({ id: "cid" })]))).toBe("cid");
    // Wrong record type → no id.
    expect(
      codex.extractNativeId(ctx("/p", [{ type: "other", payload: { id: "x" } }])),
    ).toBeUndefined();
    // Missing payload → no id.
    expect(codex.extractNativeId(ctx("/p", [{ type: "session_meta" }]))).toBeUndefined();
  });

  it("extractMetadata reads cwd from payload and branch from payload.git", () => {
    const record = meta({ cwd: "/work", git: { branch: "dev", commit_hash: "abc" } });
    expect(codex.extractMetadata?.(ctx("/p", [record]))).toEqual({
      cwd: "/work",
      recordedBranch: "dev",
    });
  });

  it("extractMetadata yields undefined branch when git block is missing", () => {
    expect(codex.extractMetadata?.(ctx("/p", [meta({ cwd: "/work" })]))).toEqual({
      cwd: "/work",
      recordedBranch: undefined,
    });
  });

  it("deriveProjects groups all sessions under a single flat 'codex' project", () => {
    const refs = [refAt("/a.jsonl"), refAt("/b.jsonl")];
    expect(codex.deriveProjects(refs)).toEqual([
      {
        providerId: "codex",
        projectId: "codex",
        displayName: "Codex sessions",
        sessions: refs,
        sessionCount: 2,
      },
    ]);
    expect(codex.deriveProjects([])).toEqual([]);
  });
});

describe("gemini descriptor extractors", () => {
  it("extractNativeId reads sessionId off the header record", () => {
    expect(gemini.extractNativeId(ctx("/p", [{ sessionId: "g-1" }]))).toBe("g-1");
    expect(gemini.extractNativeId(ctx("/p", [{}]))).toBeUndefined();
  });

  it("deriveProjects is a single flat 'gemini' group", () => {
    const refs = [refAt("/x.jsonl")];
    expect(gemini.deriveProjects(refs)).toEqual([
      {
        providerId: "gemini",
        projectId: "gemini",
        displayName: "Gemini sessions",
        sessions: refs,
        sessionCount: 1,
      },
    ]);
  });
});

describe("cursor descriptor extractors", () => {
  const composerPath = "/home/Library/.../state.vscdb::composer::comp-uuid-1";
  const transcriptPath =
    "/home/.cursor/projects/-Users-me-repo/agent-transcripts/sess-uuid-2/sess-uuid-2.jsonl";

  it("extractNativeId reads the composerId for a vscdb composer ref", () => {
    expect(cursor.extractNativeId(ctx(composerPath))).toBe("comp-uuid-1");
  });

  it("extractNativeId reads the transcript dir id for a cursor-agent ref", () => {
    expect(cursor.extractNativeId(ctx(transcriptPath))).toBe("sess-uuid-2");
  });

  it("extractMetadata decodes cwd only for transcript refs (composers have no path link)", () => {
    // The encoded segment "-Users-me-repo" decodes by mapping every "-"→"/" then
    // prefixing a "/", so the leading "-" yields a "//" (lossy but only consumed
    // by the fail-closed git resolver).
    expect(cursor.extractMetadata?.(ctx(transcriptPath))).toEqual({ cwd: "//Users/me/repo" });
    expect(cursor.extractMetadata?.(ctx(composerPath))).toEqual({ cwd: undefined });
  });

  it("deriveProjects groups composers under a single 'cursor' project", () => {
    const refs = [refAt(composerPath), refAt("/state.vscdb::composer::comp-2")];
    const groups = cursor.deriveProjects(refs);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      providerId: "cursor",
      projectId: "cursor",
      sessionCount: 2,
    });
  });

  it("deriveProjects groups transcripts by their projects/<id> path segment", () => {
    const a = refAt("/h/.cursor/projects/projA/agent-transcripts/s1/s1.jsonl");
    const b = refAt("/h/.cursor/projects/projB/agent-transcripts/s2/s2.jsonl");
    const groups = cursor.deriveProjects([a, b]);
    expect(groups.map((g) => g.projectId).toSorted()).toEqual(["projA", "projB"]);
    for (const g of groups) {
      expect(g.providerId).toBe("cursor");
      expect(g.sessionCount).toBe(1);
    }
  });
});

describe("cursor discover / probe / decode overrides", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-cursor-desc-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("probe is false with no IDE store and no transcripts root", async () => {
    expect(await cursor.probe?.({ homeDir: home })).toBe(false);
  });

  it("probe is true when the cursor-agent transcripts root exists (terminal-only user)", async () => {
    mkdirSync(path.join(home, ".cursor", "projects"), { recursive: true });
    expect(await cursor.probe?.({ homeDir: home })).toBe(true);
  });

  it("discoverRefs returns the union of composers and transcripts", async () => {
    // No vscdb and no transcripts on a bare home → empty, but the override runs
    // both discoverers and concatenates without throwing.
    expect(await cursor.discoverRefs?.({ homeDir: home })).toEqual([]);
  });

  it("decodeRecords routes a transcript ref to the transcript decoder", async () => {
    // A missing transcript path decodes to an empty record set (honest absence)
    // rather than throwing — proving the routing reached the agent decoder, not
    // the vscdb decoder (which would try to open a SQLite DB at this path).
    const ref = refAt(path.join(home, ".cursor/projects/p/agent-transcripts/s/s.jsonl"));
    await expect(cursor.decodeRecords?.(ref)).resolves.toEqual([]);
  });
});

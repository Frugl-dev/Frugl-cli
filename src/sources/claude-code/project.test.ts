import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverClaudeSessions } from "./discover.js";
import { writeTestSessions } from "../../e2e/helpers/fixtures.js";
import { decodeProjectPath, deriveClaudeProjects, extractWorktreePath } from "./project.js";
import type { SessionRef } from "../types.js";

describe("deriveClaudeProjects", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-project-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("decodes an encoded project directory into a readable path", () => {
    expect(decodeProjectPath("-Users-shawn-code-app")).toBe("/Users/shawn/code/app");
    expect(decodeProjectPath("-home-me-scratch")).toBe("/home/me/scratch");
  });

  it("extracts the worktree sub-path from a session absolutePath", () => {
    // Claude encodes both "/" and "." as "-", so ".claude/worktrees/" becomes "--claude-worktrees-"
    expect(
      extractWorktreePath(
        "/home/me/.claude/projects/-Users-me-repo--claude-worktrees-001-cloud-ingest-db/sess.jsonl",
      ),
    ).toBe("001/cloud/ingest/db");
    expect(
      extractWorktreePath(
        "/home/me/.claude/projects/-Users-me-repo/.claude-worktrees/main/sess.jsonl",
      ),
    ).toBeNull();
    expect(extractWorktreePath("/home/me/.claude/projects/-Users-me-app/sess.jsonl")).toBeNull();
  });

  it("groups sessions by project and partitions every ref exactly once", async () => {
    await writeTestSessions(home, 2, "-Users-me-app");
    await writeTestSessions(home, 1, "-Users-me-scratch");

    const refs = await discoverClaudeSessions({ homeDir: home });
    const groups = deriveClaudeProjects(refs);

    expect(groups).toHaveLength(2);
    const byId = new Map(groups.map((g) => [g.projectId, g]));
    expect(byId.get("-Users-me-app")?.sessionCount).toBe(2);
    expect(byId.get("-Users-me-app")?.displayName).toBe("/Users/me/app");
    expect(byId.get("-Users-me-scratch")?.sessionCount).toBe(1);

    // Exact partition: union of group sessions === discovered refs, no dupes.
    const grouped = groups
      .flatMap((g) => g.sessions.map((s: SessionRef) => s.absolutePath))
      .toSorted();
    expect(grouped).toEqual(refs.map((r) => r.absolutePath).toSorted());
  });

  it("returns an empty list when there are no sessions", () => {
    expect(deriveClaudeProjects([])).toEqual([]);
  });

  it("merges worktree paths from the same repo into one group", async () => {
    // Two worktrees under the same repo, plus a session in a different project.
    // Claude encodes both "/" and "." as "-", so ".claude/worktrees/" → "--claude-worktrees-"
    await writeTestSessions(home, 1, "-Users-me-repo--claude-worktrees-branch1");
    await writeTestSessions(home, 3, "-Users-me-repo--claude-worktrees-branch2");
    await writeTestSessions(home, 2, "-Users-me-other");

    const refs = await discoverClaudeSessions({ homeDir: home });
    const groups = deriveClaudeProjects(refs);

    expect(groups).toHaveLength(2);
    const byId = new Map(groups.map((g) => [g.projectId, g]));

    // Both worktree sessions are merged under the encoded repo root.
    const repoGroup = byId.get("-Users-me-repo");
    expect(repoGroup).toBeDefined();
    expect(repoGroup?.sessionCount).toBe(4);
    expect(repoGroup?.displayName).toBe("/Users/me/repo");

    // Unrelated project stays separate.
    expect(byId.get("-Users-me-other")?.sessionCount).toBe(2);

    // Exact partition.
    const grouped = groups
      .flatMap((g) => g.sessions.map((s: SessionRef) => s.absolutePath))
      .toSorted();
    expect(grouped).toEqual(refs.map((r) => r.absolutePath).toSorted());
  });

  it("keeps worktrees from different repos in separate groups", async () => {
    await writeTestSessions(home, 1, "-Users-me-repo-a--claude-worktrees-feat");
    await writeTestSessions(home, 2, "-Users-me-repo-b--claude-worktrees-feat");

    const refs = await discoverClaudeSessions({ homeDir: home });
    const groups = deriveClaudeProjects(refs);

    expect(groups).toHaveLength(2);
    const byId = new Map(groups.map((g) => [g.projectId, g]));
    expect(byId.get("-Users-me-repo-a")?.sessionCount).toBe(1);
    expect(byId.get("-Users-me-repo-b")?.sessionCount).toBe(2);
  });
});

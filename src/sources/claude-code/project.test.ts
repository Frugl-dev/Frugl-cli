import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverClaudeSessions } from "./discover.js";
import { writeTestSessions } from "../../e2e/helpers/fixtures.js";
import { decodeProjectPath, deriveClaudeProjects } from "./project.js";
import type { SessionRef } from "../types.js";

describe("deriveClaudeProjects", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "poppi-project-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("decodes an encoded project directory into a readable path", () => {
    expect(decodeProjectPath("-Users-shawn-code-app")).toBe("/Users/shawn/code/app");
    expect(decodeProjectPath("-home-me-scratch")).toBe("/home/me/scratch");
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
});

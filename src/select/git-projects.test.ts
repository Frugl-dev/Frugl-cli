import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { groupByGitProject, isGitRepoGroup } from "./git-projects.js";
import { resolveRepositoryIdentity } from "../upload/git-context.js";
import type { ProjectGroup } from "../sources/providers.js";
import type { SessionRef } from "../sources/types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "frugl-gitproj-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRepo(dir: string, originUrl: string): void {
  const gitDir = path.join(dir, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(gitDir, "config"), `[remote "origin"]\n\turl = ${originUrl}\n`);
}

function ref(absolutePath: string): SessionRef {
  return { sourceKind: "claude-code", absolutePath, byteSizeOnDisk: 1, mtimeMs: 1 };
}

function group(
  over: Partial<ProjectGroup> & { projectId: string; sessions: SessionRef[] },
): ProjectGroup {
  return {
    providerId: "claude",
    displayName: over.displayName ?? over.projectId,
    sessionCount: over.sessions.length,
    ...over,
  };
}

describe("resolveRepositoryIdentity", () => {
  it("reads owner/name from the origin remote", async () => {
    makeRepo(root, "git@github.com:acme/widgets.git");
    expect(await resolveRepositoryIdentity(root)).toEqual({
      host: "github.com",
      owner: "acme",
      name: "widgets",
    });
  });

  it("walks up to the enclosing repo from a subdirectory", async () => {
    makeRepo(root, "https://github.com/acme/widgets.git");
    const sub = path.join(root, "apps", "web");
    mkdirSync(sub, { recursive: true });
    expect((await resolveRepositoryIdentity(sub))?.name).toBe("widgets");
  });

  it("returns null for a non-repo dir, a missing cwd, and undefined", async () => {
    expect(await resolveRepositoryIdentity(root)).toBeNull();
    expect(await resolveRepositoryIdentity(path.join(root, "nope"))).toBeNull();
    expect(await resolveRepositoryIdentity(undefined)).toBeNull();
  });
});

describe("groupByGitProject", () => {
  it("collapses subdir groups of the same repo into one owner/name row", async () => {
    makeRepo(root, "https://github.com/acme/widgets.git");
    const web = path.join(root, "apps", "web");
    const pkg = path.join(root, "packages", "core");
    mkdirSync(web, { recursive: true });
    mkdirSync(pkg, { recursive: true });

    const groups = [
      group({
        projectId: "p-root",
        displayName: root,
        sessions: [ref("/a.jsonl"), ref("/b.jsonl")],
      }),
      group({ projectId: "p-web", displayName: web, sessions: [ref("/c.jsonl")] }),
      group({ projectId: "p-pkg", displayName: pkg, sessions: [ref("/d.jsonl")] }),
    ];
    const cwd = new Map([
      ["p-root", root],
      ["p-web", web],
      ["p-pkg", pkg],
    ]);

    const out = await groupByGitProject(groups, (g) => [cwd.get(g.projectId) ?? ""]);
    expect(out).toHaveLength(1);
    expect(out[0]!.displayName).toBe("acme/widgets");
    expect(out[0]!.projectId).toBe("repo:github.com/acme/widgets");
    expect(out[0]!.sessionCount).toBe(4);
    expect(out[0]!.sessions).toHaveLength(4);
    expect(isGitRepoGroup(out[0]!)).toBe(true);
  });

  it("keeps non-repo groups as path-labelled fallbacks (not git-backed)", async () => {
    const groups = [
      group({ projectId: "p-loose", displayName: "/some/path", sessions: [ref("/x.jsonl")] }),
    ];
    const out = await groupByGitProject(groups, () => []);
    expect(out).toHaveLength(1);
    expect(out[0]!.projectId).toBe("p-loose");
    expect(out[0]!.displayName).toBe("/some/path");
    expect(isGitRepoGroup(out[0]!)).toBe(false);
  });

  it("sorts repos by session count descending", async () => {
    const big = path.join(root, "big");
    const small = path.join(root, "small");
    makeRepo(big, "https://github.com/acme/big.git");
    makeRepo(small, "https://github.com/acme/small.git");

    const groups = [
      group({ projectId: "p-small", sessions: [ref("/s.jsonl")] }),
      group({ projectId: "p-big", sessions: [ref("/a.jsonl"), ref("/b.jsonl")] }),
    ];
    const cwd = new Map([
      ["p-small", small],
      ["p-big", big],
    ]);
    const out = await groupByGitProject(groups, (g) => [cwd.get(g.projectId) ?? ""]);
    expect(out.map((g) => g.displayName)).toEqual(["acme/big", "acme/small"]);
  });
});

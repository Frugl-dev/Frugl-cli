import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveGitContext } from "./git-context.js";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "frugl-git-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface RepoSpec {
  configBody?: string; // raw .git/config contents
  head: string; // raw .git/HEAD contents (no trailing newline needed)
  looseRefs?: Record<string, string>; // "refs/heads/x" -> sha
  packedRefs?: string; // raw .git/packed-refs contents
}

function makeRepo(dir: string, spec: RepoSpec): void {
  const gitDir = path.join(dir, ".git");
  mkdirSync(gitDir, { recursive: true });
  if (spec.configBody !== undefined) writeFileSync(path.join(gitDir, "config"), spec.configBody);
  writeFileSync(path.join(gitDir, "HEAD"), `${spec.head}\n`);
  for (const [ref, sha] of Object.entries(spec.looseRefs ?? {})) {
    const refFile = path.join(gitDir, ref);
    mkdirSync(path.dirname(refFile), { recursive: true });
    writeFileSync(refFile, `${sha}\n`);
  }
  if (spec.packedRefs !== undefined)
    writeFileSync(path.join(gitDir, "packed-refs"), spec.packedRefs);
}

const originConfig = (url: string): string => `[remote "origin"]\n\turl = ${url}\n`;

describe("resolveGitContext — resolution matrix (SC-002)", () => {
  it("clean repo + GitHub origin on a feature branch", async () => {
    makeRepo(root, {
      configBody: originConfig("https://github.com/acme/widgets.git"),
      head: "ref: refs/heads/005-cli-pr-metadata",
      looseRefs: { "refs/heads/005-cli-pr-metadata": SHA },
    });

    const res = await resolveGitContext({ cwd: root });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") throw new Error("unreachable");
    expect(res.gitContext.repository).toEqual({
      host: "github.com",
      owner: "acme",
      name: "widgets",
    });
    expect(res.gitContext.branch).toBe("005-cli-pr-metadata");
    expect(res.gitContext.commitSha).toBe(SHA);
  });

  it("resolves the enclosing repo from a subdirectory cwd (R-3)", async () => {
    makeRepo(root, {
      configBody: originConfig("git@github.com:acme/widgets.git"),
      head: "ref: refs/heads/main",
      looseRefs: { "refs/heads/main": SHA },
    });
    const sub = path.join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });

    const res = await resolveGitContext({ cwd: sub });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") throw new Error("unreachable");
    expect(res.gitContext.repository.name).toBe("widgets");
  });

  it("prefers origin when multiple remotes exist", async () => {
    makeRepo(root, {
      configBody:
        `[remote "upstream"]\n\turl = https://github.com/upstream/widgets.git\n` +
        originConfig("https://github.com/acme/widgets.git"),
      head: "ref: refs/heads/main",
      looseRefs: { "refs/heads/main": SHA },
    });

    const res = await resolveGitContext({ cwd: root });
    if (res.kind !== "resolved") throw new Error("unreachable");
    expect(res.gitContext.repository.owner).toBe("acme");
  });

  it("records a non-GitHub host unfiltered", async () => {
    makeRepo(root, {
      configBody: originConfig("https://gitlab.example.com/grp/proj.git"),
      head: "ref: refs/heads/main",
      looseRefs: { "refs/heads/main": SHA },
    });

    const res = await resolveGitContext({ cwd: root });
    if (res.kind !== "resolved") throw new Error("unreachable");
    expect(res.gitContext.repository).toEqual({
      host: "gitlab.example.com",
      owner: "grp",
      name: "proj",
    });
  });

  it("detached HEAD → branch omitted, commit present", async () => {
    makeRepo(root, {
      configBody: originConfig("https://github.com/acme/widgets.git"),
      head: SHA, // raw SHA = detached
    });

    const res = await resolveGitContext({ cwd: root });
    if (res.kind !== "resolved") throw new Error("unreachable");
    expect(res.gitContext.branch).toBeUndefined();
    expect(res.gitContext.commitSha).toBe(SHA);
  });

  it("prefers the session-recorded branch over the HEAD ref (FR-006)", async () => {
    makeRepo(root, {
      configBody: originConfig("https://github.com/acme/widgets.git"),
      head: "ref: refs/heads/main",
      looseRefs: { "refs/heads/main": SHA },
    });

    const res = await resolveGitContext({ cwd: root, recordedBranch: "feature-from-session" });
    if (res.kind !== "resolved") throw new Error("unreachable");
    expect(res.gitContext.branch).toBe("feature-from-session");
  });

  it("resolves the commit via packed-refs when there is no loose ref", async () => {
    makeRepo(root, {
      configBody: originConfig("https://github.com/acme/widgets.git"),
      head: "ref: refs/heads/main",
      packedRefs: `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n`,
    });

    const res = await resolveGitContext({ cwd: root });
    if (res.kind !== "resolved") throw new Error("unreachable");
    expect(res.gitContext.commitSha).toBe(SHA);
  });
});

describe("resolveGitContext — graceful degradation (SC-005)", () => {
  it("no cwd → unresolved:no-cwd, never throws", async () => {
    await expect(resolveGitContext({})).resolves.toEqual({ kind: "unresolved", reason: "no-cwd" });
  });

  it("missing dir → unresolved:missing-dir", async () => {
    const res = await resolveGitContext({ cwd: path.join(root, "does-not-exist") });
    expect(res).toEqual({ kind: "unresolved", reason: "missing-dir" });
  });

  it("not a repo → unresolved:not-a-repo", async () => {
    const res = await resolveGitContext({ cwd: root });
    expect(res).toEqual({ kind: "unresolved", reason: "not-a-repo" });
  });

  it("repo with no remote → unresolved:no-remote", async () => {
    makeRepo(root, { configBody: "[core]\n\tbare = false\n", head: "ref: refs/heads/main" });
    const res = await resolveGitContext({ cwd: root });
    expect(res).toEqual({ kind: "unresolved", reason: "no-remote" });
  });

  it("origin present but commit unresolvable → unresolved:no-commit", async () => {
    makeRepo(root, {
      configBody: originConfig("https://github.com/acme/widgets.git"),
      head: "ref: refs/heads/main", // no loose ref, no packed-refs
    });
    const res = await resolveGitContext({ cwd: root });
    expect(res).toEqual({ kind: "unresolved", reason: "no-commit" });
  });
});

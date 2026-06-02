import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveGitContext, type GitContext } from "./git-context.js";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const TOKEN = "ghp_PLANTEDSECRETtoken1234567890";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "frugl-git-cred-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRepoWithOrigin(url: string): void {
  const gitDir = path.join(root, ".git");
  mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  writeFileSync(path.join(gitDir, "config"), `[remote "origin"]\n\turl = ${url}\n`);
  writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(gitDir, "refs", "heads", "main"), `${SHA}\n`);
}

function flatten(ctx: GitContext): string {
  return JSON.stringify(ctx);
}

describe("resolveGitContext — credential stripping is fail-closed (SC-003)", () => {
  it.each([
    ["https with embedded token", `https://user:${TOKEN}@github.com/acme/widgets.git`],
    ["ssh with user", `ssh://${TOKEN}@github.com/acme/widgets.git`],
    ["scp-style with user", `git@github.com:acme/widgets.git`],
  ])("%s → host+owner/name only, token never recorded", async (_label, url) => {
    makeRepoWithOrigin(url);
    const res = await resolveGitContext({ cwd: root });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") throw new Error("unreachable");
    expect(res.gitContext.repository).toEqual({
      host: "github.com",
      owner: "acme",
      name: "widgets",
    });
    // The planted token appears in zero fields of the resolved context.
    expect(flatten(res.gitContext)).not.toContain(TOKEN);
    expect(flatten(res.gitContext)).not.toContain("user");
  });

  it("an unparseable origin URL → unresolved (no partial identity, fail-closed)", async () => {
    makeRepoWithOrigin("not even a url");
    const res = await resolveGitContext({ cwd: root });
    expect(res.kind).toBe("unresolved");
    if (res.kind === "resolved") throw new Error("must not resolve a partial identity");
  });

  it("an origin URL with a host but no owner/name → unresolved", async () => {
    makeRepoWithOrigin("https://github.com/");
    const res = await resolveGitContext({ cwd: root });
    expect(res.kind).toBe("unresolved");
  });
});

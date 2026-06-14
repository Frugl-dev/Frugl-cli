import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProjectIdentity, UNKNOWN_PROJECT } from "./project-identity.js";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "frugl-project-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Minimal `.git/` so resolveGitContext (which reads files, never spawns git)
// resolves a remote. Mirrors git-context.test.ts's fixture helper.
function makeRepo(dir: string, originUrl: string): void {
  const gitDir = path.join(dir, ".git");
  mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  writeFileSync(path.join(gitDir, "config"), `[remote "origin"]\n\turl = ${originUrl}\n`);
  writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(gitDir, "refs", "heads", "main"), `${SHA}\n`);
}

function writePackageJson(dir: string, name: unknown): void {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
}

describe("resolveProjectIdentity — fallback chain (spec 051)", () => {
  it("rung 1: git remote → repo segment only, lowercased (host/owner dropped)", async () => {
    makeRepo(root, "https://github.com/Frugl-Dev/Frugl.git");
    expect(await resolveProjectIdentity(root)).toBe("frugl");
  });

  it("rung 1: scp / credentialed / .git forms all normalize to the same repo name", async () => {
    const scp = path.join(root, "scp");
    const cred = path.join(root, "cred");
    mkdirSync(scp, { recursive: true });
    mkdirSync(cred, { recursive: true });
    makeRepo(scp, "git@github.com:Frugl-Dev/Frugl.git");
    makeRepo(cred, "https://user:token@github.com/Frugl-Dev/Frugl.git");
    expect(await resolveProjectIdentity(scp)).toBe("frugl");
    expect(await resolveProjectIdentity(cred)).toBe("frugl");
  });

  it("rung 1: a subdirectory cwd resolves the enclosing repo (worktree/subdir → repo root)", async () => {
    makeRepo(root, "https://github.com/acme/widgets.git");
    const sub = path.join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });
    expect(await resolveProjectIdentity(sub)).toBe("widgets");
  });

  it("rung 2: no remote → package.json name", async () => {
    writePackageJson(root, "my-tool");
    expect(await resolveProjectIdentity(root)).toBe("my-tool");
  });

  it("rung 3: no remote, no package.json → directory basename", async () => {
    const named = path.join(root, "cool-project");
    mkdirSync(named, { recursive: true });
    expect(await resolveProjectIdentity(named)).toBe("cool-project");
  });

  it("rung 4: no cwd → 'unknown'", async () => {
    expect(await resolveProjectIdentity(undefined)).toBe(UNKNOWN_PROJECT);
  });

  it("git remote wins over a present package.json (rung order)", async () => {
    makeRepo(root, "https://github.com/acme/widgets.git");
    writePackageJson(root, "ignored-pkg-name");
    expect(await resolveProjectIdentity(root)).toBe("widgets");
  });

  it("fail-closed: a broken/unparseable package.json degrades to basename, never throws", async () => {
    const named = path.join(root, "fallback-dir");
    mkdirSync(named, { recursive: true });
    writeFileSync(path.join(named, "package.json"), "{ this is not json ");
    expect(await resolveProjectIdentity(named)).toBe("fallback-dir");
  });

  it("fail-closed: a missing directory degrades down the chain without throwing", async () => {
    const missing = path.join(root, "does", "not", "exist");
    await expect(resolveProjectIdentity(missing)).resolves.toBe("exist");
  });
});

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface GitRepositoryIdentity {
  host: string;
  owner: string;
  name: string;
}

export interface GitContext {
  repository: GitRepositoryIdentity;
  branch?: string;
  commitSha: string;
}

export type UnresolvedReason =
  | "no-cwd"
  | "missing-dir"
  | "not-a-repo"
  | "no-remote"
  | "unparseable-remote"
  | "no-commit";

export type GitContextResolution =
  | { kind: "resolved"; gitContext: GitContext }
  | { kind: "unresolved"; reason: UnresolvedReason }
  | { kind: "git-unavailable" };

export interface ResolveGitContextInput {
  cwd?: string;
  recordedBranch?: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;

// Resolve a credential-free git coordinate by reading `.git/` files ONLY — never
// spawning `git` (no hooks, no git dependency; R-2). NEVER throws: every failure
// becomes an `unresolved`/`git-unavailable` variant (FR-008/FR-009/R-8).
export async function resolveGitContext(
  input: ResolveGitContextInput,
): Promise<GitContextResolution> {
  const cwd = input.cwd;
  if (cwd === undefined || cwd.length === 0) return { kind: "unresolved", reason: "no-cwd" };

  try {
    const cwdKind = await statKind(cwd);
    if (cwdKind === "missing") return { kind: "unresolved", reason: "missing-dir" };
    if (cwdKind === "error") return { kind: "git-unavailable" };

    const gitDir = await findGitDir(cwd);
    if (gitDir === null) return { kind: "unresolved", reason: "not-a-repo" };

    const config = await readFileSafe(path.join(gitDir, "config"));
    const originUrl = config === null ? null : parseOriginUrl(config);
    if (originUrl === null) return { kind: "unresolved", reason: "no-remote" };

    const repository = parseRemoteIdentity(originUrl);
    if (repository === null) return { kind: "unresolved", reason: "unparseable-remote" };

    const head = await readFileSafe(path.join(gitDir, "HEAD"));
    if (head === null) return { kind: "unresolved", reason: "no-commit" };

    const { branch, commitSha } = await resolveHeadCommit(
      gitDir,
      head.trim(),
      input.recordedBranch,
    );
    if (commitSha === undefined) return { kind: "unresolved", reason: "no-commit" };

    const gitContext: GitContext = {
      repository,
      ...(branch !== undefined ? { branch } : {}),
      commitSha,
    };
    return { kind: "resolved", gitContext };
  } catch {
    // An unexpected error reading git internals — treat as host-level inability.
    return { kind: "git-unavailable" };
  }
}

type StatKind = "dir" | "file" | "missing" | "error";

async function statKind(target: string): Promise<StatKind> {
  try {
    const s = await stat(target);
    if (s.isDirectory()) return "dir";
    if (s.isFile()) return "file";
    return "error";
  } catch (err) {
    if (isMissing(err)) return "missing";
    return "error";
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readFileSafe(target: string): Promise<string | null> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

// Ascend from `cwd` to the enclosing repo root, returning the resolved `.git`
// directory (handling the `gitdir:` pointer file used by worktrees/submodules).
async function findGitDir(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    const kind = await statKind(dotGit);
    if (kind === "dir") return dotGit;
    if (kind === "file") {
      const pointer = await readFileSafe(dotGit);
      const match = pointer?.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const target = match[1]!.trim();
        const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target);
        if ((await statKind(resolved)) === "dir") return resolved;
      }
      return null; // unresolvable pointer → fail-closed
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

// Find the `origin` remote URL in an INI-style `.git/config`. Prefers `origin`
// when multiple remotes exist (R-4).
function parseOriginUrl(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
      continue;
    }
    if (inOrigin) {
      const url = line.match(/^url\s*=\s*(.+)$/);
      if (url) return url[1]!.trim();
    }
  }
  return null;
}

// Parse an origin URL into host + owner/name, stripping any credential. Builds
// fresh strings and discards the rest of the URL, so a token cannot survive into
// the result (R-4 / FR-005 / SC-003). Returns null (fail-closed) if unparseable.
function parseRemoteIdentity(raw: string): GitRepositoryIdentity | null {
  const url = raw.trim();

  if (!url.includes("://")) {
    // scp-style: [user@]host:owner/name(.git)?
    const scp = url.match(/^(?:[^@/]+@)?([^@/:]+):(.+)$/);
    if (scp) return identityFromHostPath(scp[1]!, "", scp[2]!);
  }

  try {
    const u = new URL(url);
    const port = u.port ? `:${u.port}` : "";
    return identityFromHostPath(u.hostname, port, u.pathname);
  } catch {
    return null;
  }
}

function identityFromHostPath(
  hostname: string,
  port: string,
  pathPart: string,
): GitRepositoryIdentity | null {
  const host = `${hostname}${port}`.toLowerCase();
  if (!/^[a-z0-9.-]+(:[0-9]+)?$/.test(host)) return null;

  const segments = pathPart
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;

  const name = segments[segments.length - 1]!;
  const owner = segments[segments.length - 2]!;
  if (!isCleanSegment(owner) || !isCleanSegment(name)) return null;

  return { host, owner, name };
}

function isCleanSegment(value: string): boolean {
  return value.length > 0 && !/[@\s/]/.test(value);
}

async function resolveHeadCommit(
  gitDir: string,
  head: string,
  recordedBranch: string | undefined,
): Promise<{ branch?: string; commitSha?: string }> {
  let branchFromHead: string | undefined;
  let commitSha: string | undefined;

  if (SHA_RE.test(head)) {
    commitSha = head; // detached HEAD — no branch from here
  } else {
    const ref = head.match(/^ref:\s*(.+)$/);
    if (ref) {
      const refPath = ref[1]!.trim();
      const heads = refPath.match(/^refs\/heads\/(.+)$/);
      if (heads) branchFromHead = heads[1];
      commitSha = await resolveRef(gitDir, refPath);
    }
  }

  // FR-006: prefer the session-recorded branch; otherwise the HEAD ref's branch;
  // a detached HEAD (no ref, no recorded branch) yields no branch.
  const branch =
    recordedBranch !== undefined && recordedBranch.length > 0 ? recordedBranch : branchFromHead;

  const result: { branch?: string; commitSha?: string } = {};
  if (branch !== undefined && branch.length > 0) result.branch = branch;
  if (commitSha !== undefined && SHA_RE.test(commitSha)) result.commitSha = commitSha;
  return result;
}

// Resolve a ref to its 40-hex SHA: loose ref file first, then `.git/packed-refs`.
async function resolveRef(gitDir: string, ref: string): Promise<string | undefined> {
  const loose = await readFileSafe(path.join(gitDir, ref));
  if (loose) {
    const sha = loose.trim();
    if (SHA_RE.test(sha)) return sha;
  }
  const packed = await readFileSafe(path.join(gitDir, "packed-refs"));
  if (packed) {
    for (const raw of packed.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
      const match = line.match(/^([0-9a-f]{40})\s+(.+)$/);
      if (match && match[2]!.trim() === ref) return match[1];
    }
  }
  return undefined;
}

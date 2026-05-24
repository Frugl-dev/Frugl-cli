import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const FIXTURE_SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

export interface MakeRepoOptions {
  originUrl: string;
  branch?: string;
  sha?: string;
}

/** Creates a minimal read-only `.git` directory (config + HEAD + loose ref). */
export async function makeGitRepo(root: string, opts: MakeRepoOptions): Promise<void> {
  const branch = opts.branch ?? "main";
  const sha = opts.sha ?? FIXTURE_SHA;
  const gitDir = path.join(root, ".git");
  await mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
  await writeFile(path.join(gitDir, "config"), `[remote "origin"]\n\turl = ${opts.originUrl}\n`);
  await writeFile(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  await writeFile(path.join(gitDir, "refs", "heads", branch), `${sha}\n`);
}

export interface WriteGitSessionOptions {
  cwd?: string;
  gitBranch?: string;
  projName?: string;
}

/** Writes one Claude Code JSONL session whose records carry `cwd`/`gitBranch`. */
export async function writeGitSession(
  homeDir: string,
  opts: WriteGitSessionOptions = {},
): Promise<string> {
  const projName = opts.projName ?? "git-project";
  const projectDir = path.join(homeDir, ".claude", "projects", projName);
  await mkdir(projectDir, { recursive: true });
  const sessionId = randomUUID();
  const first: Record<string, unknown> = {
    sessionId,
    type: "user",
    message: "hello",
    timestamp: new Date().toISOString(),
  };
  if (opts.cwd !== undefined) first["cwd"] = opts.cwd;
  if (opts.gitBranch !== undefined) first["gitBranch"] = opts.gitBranch;
  const records = [
    first,
    { sessionId, type: "assistant", message: "hi", timestamp: new Date().toISOString() },
  ];
  await writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return sessionId;
}

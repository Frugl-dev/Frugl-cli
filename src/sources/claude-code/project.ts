import path from "node:path";
import type { SessionRef } from "../types.js";
import type { ProjectGroup } from "../providers.js";

// Claude encodes a project's working directory as a single directory name under
// ~/.claude/projects/, replacing every "/" with "-" (so a leading "/" becomes a
// leading "-"). Decoding is display-only; grouping keys on the raw directory
// name so dashes inside real path segments never cause mis-grouping.
export function decodeProjectPath(dirName: string): string {
  return dirName.replace(/-/g, "/");
}

// Encodes a decoded path back to Claude's directory-name format.
function encodeProjectPath(decodedPath: string): string {
  return decodedPath.replace(/\//g, "-");
}

const WORKTREE_MARKER = "/.claude/worktrees/";

// If the decoded path is a git worktree path (contains /.claude/worktrees/),
// returns the repo root (the part before /.claude/worktrees/). Otherwise null.
function worktreeRepoRoot(decodedPath: string): string | null {
  const idx = decodedPath.indexOf(WORKTREE_MARKER);
  if (idx === -1) return null;
  return decodedPath.slice(0, idx);
}

// Given a session absolutePath (e.g. ~/.claude/projects/<encoded>/session.jsonl),
// returns the worktree sub-path (e.g. "001/cloud/ingest/db") if the session lives
// in a git worktree, or null otherwise. Used to populate the DB metadata field.
export function extractWorktreePath(absolutePath: string): string | null {
  const encoded = path.basename(path.dirname(absolutePath));
  const decoded = decodeProjectPath(encoded);
  const idx = decoded.indexOf(WORKTREE_MARKER);
  if (idx === -1) return null;
  return decoded.slice(idx + WORKTREE_MARKER.length);
}

export function deriveClaudeProjects(refs: SessionRef[]): ProjectGroup[] {
  const byProject = new Map<string, SessionRef[]>();
  const displayNames = new Map<string, string>();

  for (const ref of refs) {
    const rawId = path.basename(path.dirname(ref.absolutePath));
    const decoded = decodeProjectPath(rawId);
    const repoRoot = worktreeRepoRoot(decoded);

    const groupKey = repoRoot !== null ? encodeProjectPath(repoRoot) : rawId;
    const displayName = repoRoot ?? decoded;

    displayNames.set(groupKey, displayName);
    const sessions = byProject.get(groupKey);
    if (sessions) sessions.push(ref);
    else byProject.set(groupKey, [ref]);
  }

  const groups: ProjectGroup[] = [];
  for (const [projectId, sessions] of byProject) {
    groups.push({
      providerId: "claude",
      projectId,
      displayName: displayNames.get(projectId)!,
      sessions,
      sessionCount: sessions.length,
    });
  }
  return groups;
}

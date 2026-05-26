import path from "node:path";
import type { SessionRef } from "../types.js";
import type { ProjectGroup } from "../providers.js";

// Claude encodes a project's working directory as a single directory name under
// ~/.claude/projects/, replacing every "/" and "." with "-" (so a leading "/"
// becomes a leading "-" and ".claude" becomes "-claude"). Decoding is
// display-only; grouping keys on the raw directory name so dashes inside real
// path segments never cause mis-grouping.
export function decodeProjectPath(dirName: string): string {
  return dirName.replace(/-/g, "/");
}

// Claude encodes both "/" and "." as "-", so ".claude/worktrees/" becomes
// "--claude-worktrees-" in the raw directory name. We detect worktrees at the
// encoded level to avoid ambiguity from the lossy decode.
const WORKTREE_MARKER_ENCODED = "--claude-worktrees-";

// If the raw encoded id is a git worktree path, returns the encoded repo root
// (the part before "--claude-worktrees-"). Otherwise null.
function worktreeRepoRootEncoded(rawId: string): string | null {
  const idx = rawId.indexOf(WORKTREE_MARKER_ENCODED);
  if (idx === -1) return null;
  return rawId.slice(0, idx);
}

// Given a session absolutePath (e.g. ~/.claude/projects/<encoded>/session.jsonl),
// returns the worktree sub-path (e.g. "001/cloud/ingest/db") if the session lives
// in a git worktree, or null otherwise. Used to populate the DB metadata field.
export function extractWorktreePath(absolutePath: string): string | null {
  const encoded = path.basename(path.dirname(absolutePath));
  const idx = encoded.indexOf(WORKTREE_MARKER_ENCODED);
  if (idx === -1) return null;
  return decodeProjectPath(encoded.slice(idx + WORKTREE_MARKER_ENCODED.length));
}

export function deriveClaudeProjects(refs: SessionRef[]): ProjectGroup[] {
  const byProject = new Map<string, SessionRef[]>();
  const displayNames = new Map<string, string>();

  for (const ref of refs) {
    const rawId = path.basename(path.dirname(ref.absolutePath));
    const repoRootEncoded = worktreeRepoRootEncoded(rawId);

    const groupKey = repoRootEncoded ?? rawId;
    const displayName = decodeProjectPath(repoRootEncoded ?? rawId);

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

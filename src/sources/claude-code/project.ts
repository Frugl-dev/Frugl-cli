import { readdirSync } from "node:fs";
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

// The forward direction of Claude's encoding: "/" and "." become "-". Unlike
// decodeProjectPath this is the one Claude itself applies when it creates a
// project directory, so — unlike a decoded displayName — comparing an encoded
// path against a raw on-disk directory name (projectId) is exact, even when a
// real path segment contains a literal "-" (e.g. "frugl-cli").
export function encodeProjectPath(absolutePath: string): string {
  return absolutePath.replace(/[/.]/g, "-");
}

// Reverses encodeProjectPath without the ambiguity decodeProjectPath has, by
// walking the real filesystem instead of blindly splitting on "-": at each
// level, the remaining encoded suffix is matched against real directory
// entries (each re-encoded the same way Claude encodes on disk), descending
// into the longest match. This correctly resolves a hyphenated segment like
// "Frugl-Cli" that decodeProjectPath would otherwise split into "Frugl/Cli",
// because it only ever descends into directories that actually exist.
// Returns null when the chain can't be fully resolved (the directory was
// renamed/deleted since the session was recorded, a permission error, or
// rawId isn't an absolute-path encoding) — callers should fall back to
// decodeProjectPath in that case.
export function resolveProjectPath(rawId: string): string | null {
  if (!rawId.startsWith("-")) return null;
  let dir = path.parse(process.cwd()).root;
  let remaining = rawId.slice(1);

  while (remaining.length > 0) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    let bestName: string | null = null;
    let bestEncodedLength = -1;
    let bestRemainder = "";
    for (const entry of entries) {
      // Follow symlinks too (e.g. macOS "/tmp" -> "/private/tmp"): a symlink
      // entry's dirent type reflects the link itself, not its target, but if
      // it doesn't actually lead to a directory the next readdirSync will
      // throw and this resolution safely falls back to null.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const encoded = encodeProjectPath(entry.name);
      let remainder: string | null = null;
      if (remaining === encoded) remainder = "";
      else if (remaining.startsWith(`${encoded}-`)) remainder = remaining.slice(encoded.length + 1);
      if (remainder !== null && encoded.length > bestEncodedLength) {
        bestName = entry.name;
        bestEncodedLength = encoded.length;
        bestRemainder = remainder;
      }
    }

    if (bestName === null) return null;
    dir = path.join(dir, bestName);
    remaining = bestRemainder;
  }

  return dir;
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

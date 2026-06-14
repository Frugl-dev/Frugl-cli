import type { ProjectGroup } from "../sources/providers.js";
import { resolveRepositoryIdentity } from "../upload/git-context.js";

// The candidate working directories a project group's sessions were recorded
// from, in priority order. The caller supplies it because the cwd lives on the
// parsed session, not on the SessionRef the group is built from. Several
// candidates are allowed because a group can span subdirs/worktrees of one repo
// and any single recorded cwd may point at a directory since deleted — the
// grouper takes the first candidate that resolves to a remote.
export type CwdForGroup = (group: ProjectGroup) => string[];

// Prefix marking a merged group whose projectId is a resolved git remote (vs a
// path fallback). Synthetic and collision-proof, so a real on-disk path can
// never masquerade as a repo key.
const REPO_KEY_PREFIX = "repo:";

// True when a group resolved to a git remote (an `owner/name` repo), false when
// it fell back to its on-disk path because no remote was found.
export function isGitRepoGroup(group: ProjectGroup): boolean {
  return group.projectId.startsWith(REPO_KEY_PREFIX);
}

// Regroup path-keyed project groups into GitHub-style repository groups.
//
// The raw groups are keyed by each tool's encoded working directory, so the same
// repo shows up once per subdirectory (apps/web, packages/*, the repo root, a
// worktree…). Here we resolve each group's recorded cwd to its git `origin`
// remote and collapse every group that maps to the same repo into one entry
// labelled `owner/name`. Groups whose cwd is not a git repo (or has no remote,
// or had no parsed cwd to resolve) keep their original path identity as a
// fallback, so nothing is ever silently dropped.
//
// Resolution is memoized per cwd and reads `.git/` files only (never spawns
// git), so the cost is one cheap filesystem walk per distinct directory.
export async function groupByGitProject(
  groups: ProjectGroup[],
  cwdForGroup: CwdForGroup,
): Promise<ProjectGroup[]> {
  const memo = new Map<string, string | null>();
  const merged = new Map<string, ProjectGroup>();
  const order: string[] = [];

  for (const g of groups) {
    let repoKey: string | null = null;
    for (const cwd of cwdForGroup(g)) {
      if (cwd.length === 0) continue;
      let resolved = memo.get(cwd);
      if (resolved === undefined) {
        const identity = await resolveRepositoryIdentity(cwd);
        resolved = identity ? `${identity.host}/${identity.owner}/${identity.name}` : null;
        memo.set(cwd, resolved);
      }
      if (resolved !== null) {
        repoKey = resolved;
        break;
      }
    }

    // A synthetic, collision-proof key for the merged group: real repos share a
    // `repo:` key so they collapse; everything else keeps its own path key so it
    // stays a distinct fallback row.
    const key = repoKey !== null ? `${REPO_KEY_PREFIX}${repoKey}` : g.projectId;
    const displayName = repoKey !== null ? repoKey.slice(repoKey.indexOf("/") + 1) : g.displayName;

    const existing = merged.get(key);
    if (existing) {
      existing.sessions.push(...g.sessions);
      existing.sessionCount += g.sessionCount;
    } else {
      merged.set(key, {
        providerId: g.providerId,
        projectId: key,
        displayName,
        sessions: [...g.sessions],
        sessionCount: g.sessionCount,
      });
      order.push(key);
    }
  }

  return order
    .map((k) => merged.get(k)!)
    .toSorted(
      (a, b) => b.sessionCount - a.sessionCount || a.displayName.localeCompare(b.displayName),
    );
}

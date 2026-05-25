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

export function deriveClaudeProjects(refs: SessionRef[]): ProjectGroup[] {
  const byProject = new Map<string, SessionRef[]>();
  for (const ref of refs) {
    const projectId = path.basename(path.dirname(ref.absolutePath));
    const sessions = byProject.get(projectId);
    if (sessions) sessions.push(ref);
    else byProject.set(projectId, [ref]);
  }
  const groups: ProjectGroup[] = [];
  for (const [projectId, sessions] of byProject) {
    groups.push({
      providerId: "claude",
      projectId,
      displayName: decodeProjectPath(projectId),
      sessions,
      sessionCount: sessions.length,
    });
  }
  return groups;
}

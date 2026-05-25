import type { ProjectGroup } from "../sources/providers.js";
import type { SessionRef } from "../sources/types.js";

export interface Selection {
  providerIds: string[];
  projectIds: string[];
}

// The single source of truth for what gets uploaded: a session is included only
// if its provider AND its project were both selected. Order follows `groups`.
export function applySelection(groups: ProjectGroup[], selection: Selection): SessionRef[] {
  const providers = new Set(selection.providerIds);
  const projects = new Set(selection.projectIds);
  const refs: SessionRef[] = [];
  for (const group of groups) {
    if (!providers.has(group.providerId)) continue;
    if (!projects.has(group.projectId)) continue;
    refs.push(...group.sessions);
  }
  return refs;
}

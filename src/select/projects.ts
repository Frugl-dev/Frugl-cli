import { checkbox } from "@inquirer/prompts";
import type { ProjectGroup } from "../sources/providers.js";

export interface SelectProjectsOptions {
  interactive: boolean;
  // Per-project counts to show in the picker, overriding each group's raw
  // discovered count. Used to surface the number of sessions that will actually
  // upload after the --min-cost filter, not just how many files were found.
  counts?: Map<string, number>;
  // When set (and > 0), label the prompt so it's clear the counts exclude cheap
  // sessions, e.g. "excluding sessions under $0.01".
  minCost?: number;
}

// Returns the ids of the projects the dev wants to upload. Non-interactive (or
// nothing discovered): all projects. Interactive: a checkbox with every project
// preselected, each labelled with its decoded path and session count. When
// cost-aware counts are supplied, projects with nothing left to upload are
// shown but unchecked by default.
export async function selectProjects(
  groups: ProjectGroup[],
  opts: SelectProjectsOptions,
): Promise<string[]> {
  if (!opts.interactive || groups.length === 0) {
    return groups.map((g) => g.projectId);
  }
  const choices = groups.map((g) => {
    const count = opts.counts?.get(g.projectId) ?? g.sessionCount;
    return {
      name: `${g.displayName}  (${count})`,
      value: g.projectId,
      checked: count > 0,
    };
  });
  const message =
    opts.minCost !== undefined && opts.minCost > 0
      ? `Which projects should Frugl upload? (excluding sessions under $${opts.minCost.toFixed(2)})`
      : "Which projects should Frugl upload?";
  return checkbox({ message, choices });
}

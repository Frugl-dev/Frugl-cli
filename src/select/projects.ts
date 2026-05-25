import { checkbox } from "@inquirer/prompts";
import type { ProjectGroup } from "../sources/providers.js";

export interface SelectProjectsOptions {
  interactive: boolean;
}

// Returns the ids of the projects the dev wants to upload. Non-interactive (or
// nothing discovered): all projects. Interactive: a checkbox with every project
// preselected, each labelled with its decoded path and session count.
export async function selectProjects(
  groups: ProjectGroup[],
  opts: SelectProjectsOptions,
): Promise<string[]> {
  if (!opts.interactive || groups.length === 0) {
    return groups.map((g) => g.projectId);
  }
  const choices = groups.map((g) => ({
    name: `${g.displayName}  (${g.sessionCount})`,
    value: g.projectId,
    checked: true,
  }));
  return checkbox({ message: "Which projects should Poppi upload?", choices });
}

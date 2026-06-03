import { homedir } from "node:os";
import { sep as PATH_SEP } from "node:path";
import type { RedactionCategory } from "../policy.js";
import type { Rule, RuleContext } from "./types.js";

const PROJECTS_SEGMENT = ".claude/projects/";

export function redactClaudePaths(
  input: string,
  ctx: RuleContext,
): { output: string; counts: Partial<Record<RedactionCategory, number>> } {
  const counts: Partial<Record<RedactionCategory, number>> = {};
  const home = ctx.homeDir ?? homedir();
  if (!home) return { output: input, counts };

  const escapedHome = escapeRegExp(home);
  const homeRegex = new RegExp(`${escapedHome}([${escapeRegExp(PATH_SEP)}/]?[^\\s"']*)`, "g");

  const output = input.replace(homeRegex, (_match, rest: string) => {
    counts["home-path"] = (counts["home-path"] ?? 0) + 1;
    const replaced =
      rest.length === 0 ? "<HOME>" : `<HOME>${replaceProjectSegments(rest, ctx, counts)}`;
    return replaced;
  });
  return { output, counts };
}

function replaceProjectSegments(
  rest: string,
  ctx: RuleContext,
  counts: Partial<Record<RedactionCategory, number>>,
): string {
  const idx = rest.indexOf(PROJECTS_SEGMENT);
  if (idx < 0) return rest;
  const prefix = rest.slice(0, idx + PROJECTS_SEGMENT.length);
  const tail = rest.slice(idx + PROJECTS_SEGMENT.length);
  const [project, ...remainder] = tail.split(/[/\\]/);
  if (!project) return rest;
  counts["project-name"] = (counts["project-name"] ?? 0) + 1;
  const pseudonym = ctx.pseudonyms.pseudonymize("project-name", project);
  const tailRest = remainder.length > 0 ? `/${remainder.join("/")}` : "";
  return `${prefix}${pseudonym}${tailRest}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const claudePathsRule: Rule = {
  id: "claude-paths",
  categories: ["home-path", "project-name"],
  apply: (input, ctx) => redactClaudePaths(input, ctx),
};

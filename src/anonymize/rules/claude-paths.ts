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

  // ctx.homeDir (e.g. FRUGL_HOME_DIR pointing at a relocated tool dir) is an
  // ADDITIONAL home prefix, never a replacement: the user's real home must be
  // redacted regardless of any override.
  const homes = [...new Set([ctx.homeDir, homedir()].filter((h): h is string => Boolean(h)))];

  // Pre-pass: strip any form of memory file path down to just the filename.
  // Memory files (.claude/projects/<project>/memory/<file>.md) carry no sensitive
  // content, so Frugl can label them naturally ("MEMORY.md") instead of showing a
  // redacted project path. Handled before the general home-prefix regex because:
  //   - tilde paths (~/.claude/...) are never matched by the home-dir regex
  //   - absolute paths would otherwise become <HOME>MEMORY.md after home-replacement
  const memoryFilePatterns = [
    // tilde form: ~/.claude/projects/.../memory/<file>.md
    /~[/\\]\.claude[/\\]projects[/\\][^/\\\s"']+[/\\]memory[/\\]([^/\\\s"']+\.md)/g,
    // absolute form: /Users/alice/.claude/projects/.../memory/<file>.md
    ...homes.map(
      (home) =>
        new RegExp(
          `${escapeRegExp(home)}[/\\\\]\\.claude[/\\\\]projects[/\\\\][^/\\\\\\s"']+[/\\\\]memory[/\\\\]([^/\\\\\\s"']+\\.md)`,
          "g",
        ),
    ),
  ];
  let output = input;
  for (const re of memoryFilePatterns) {
    output = output.replace(re, (_match, filename: string) => {
      counts["home-path"] = (counts["home-path"] ?? 0) + 1;
      counts["project-name"] = (counts["project-name"] ?? 0) + 1;
      return filename;
    });
  }

  if (homes.length === 0) return { output, counts };

  for (const home of homes) {
    const escapedHome = escapeRegExp(home);
    const homeRegex = new RegExp(`${escapedHome}([${escapeRegExp(PATH_SEP)}/]?[^\\s"']*)`, "g");
    output = output.replace(homeRegex, (_match, rest: string) => {
      counts["home-path"] = (counts["home-path"] ?? 0) + 1;
      return rest.length === 0 ? "<HOME>" : `<HOME>${replaceProjectSegments(rest, ctx, counts)}`;
    });
  }
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

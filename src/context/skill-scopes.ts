import type { WireSkillScopeEntry, WireSkillScopesPayload } from "../cloud/schemas.js";

// Build the skill-scopes manifest payload (spec 047 Phase 8) from a captured
// Claude Code /context breakdown. The breakdown's "Skills" table carries a
// `Source` column (User / Project / Plugin (name) / Built-in) that states each
// LOADED skill's scope — the one thing the cloud's typed store can't recover
// from the raw text, since its parser only keeps the skill name + token count.
// Names are config identifiers the anonymizer preserves verbatim, so they match
// the skill items the server parses from the uploaded text 1:1.
//
// Fail-open like the MCP inventory: an older /context with no Source column, or
// a capture with no scope-bearing skills, yields null and the payload is simply
// omitted from the manifest — never a fabricated or partial scope.

// Map a /context "Source" cell to the canonical scope vocabulary. "Built-in"
// (Claude Code's own skills) has no user/project/plugin scope and the dashboard
// excludes those skills anyway, so it is skipped rather than guessed at.
function sourceToScope(source: string): WireSkillScopeEntry["scope"] | null {
  const s = source.trim().toLowerCase();
  if (s.startsWith("user")) return "user";
  if (s.startsWith("project")) return "project";
  if (s.startsWith("plugin")) return "plugin";
  return null;
}

const SEPARATOR_ROW = /^:?-+:?$/;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseSkillScopesFromContext(
  text: string,
  capturedAt: string,
): WireSkillScopesPayload | null {
  const lines = text.split(/\r?\n/);

  let inSkills = false;
  let header: string[] | null = null;
  let skillCol = -1;
  let sourceCol = -1;
  const seen = new Set<string>();
  const skills: WireSkillScopeEntry[] = [];

  for (const line of lines) {
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inSkills = heading[1]?.trim().toLowerCase() === "skills";
      header = null;
      continue;
    }
    if (!inSkills || !line.trimStart().startsWith("|")) continue;

    const cells = tableCells(line);
    if (cells.every((c) => SEPARATOR_ROW.test(c))) continue;

    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      skillCol = header.indexOf("skill");
      sourceCol = header.indexOf("source");
      continue;
    }
    // No Source column (older /context) → no scope to report for this table.
    if (skillCol < 0 || sourceCol < 0) continue;

    const name = cells[skillCol]?.trim();
    const scope = sourceToScope(cells[sourceCol] ?? "");
    if (!name || scope === null) continue;

    // The server rejects a duplicate (scope, project_key, name); /context never
    // lists a skill twice, but dedup defensively so one stray row can't drop the
    // whole payload at the trust boundary.
    const key = `${scope}\x00${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push({ name, scope, project_key: null });
  }

  if (skills.length === 0) return null;
  return {
    schema: "frugl.skill-scopes",
    schema_version: 1,
    captured_at: capturedAt,
    provider: "claude_code",
    skills,
  };
}

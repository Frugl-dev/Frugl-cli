import { describe, it, expect } from "vitest";
import { parseSkillScopesFromContext } from "./skill-scopes.js";

const CAPTURED_AT = "2026-06-22T02:34:47.242Z";

// A trimmed but representative Claude Code /context capture with the Skills
// table's Source column (User / Project / Built-in / Plugin (name)).
const CONTEXT = `## Context Usage

**Model:** claude-sonnet-4-6
**Tokens:** 23.7k / 200k (12%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| Skills | 2.4k | 1.2% |
| Free space | 143.3k | 71.6% |
| Autocompact buffer | 33k | 16.5% |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| obsidian | User | ~90 |
| use-railway | User | ~220 |
| improve-codebase-architecture | Project | ~80 |
| speckit-analyze | Project | ~40 |
| deep-research | Built-in | ~120 |
| stripe:explain-error | Plugin (stripe) | ~20 |
| stripe-best-practices | Plugin (stripe) | ~170 |
`;

describe("parseSkillScopesFromContext", () => {
  it("builds a frugl.skill-scopes payload from the Skills Source column", () => {
    const payload = parseSkillScopesFromContext(CONTEXT, CAPTURED_AT);
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      schema: "frugl.skill-scopes",
      schema_version: 1,
      captured_at: CAPTURED_AT,
      provider: "claude_code",
    });
  });

  it("maps User/Project/Plugin to scope and drops Built-in skills", () => {
    const payload = parseSkillScopesFromContext(CONTEXT, CAPTURED_AT);
    expect(payload?.skills).toEqual([
      { name: "obsidian", scope: "user", project_key: null },
      { name: "use-railway", scope: "user", project_key: null },
      { name: "improve-codebase-architecture", scope: "project", project_key: null },
      { name: "speckit-analyze", scope: "project", project_key: null },
      { name: "stripe:explain-error", scope: "plugin", project_key: null },
      { name: "stripe-best-practices", scope: "plugin", project_key: null },
    ]);
    // "deep-research | Built-in" has no user/project/plugin scope → omitted.
    expect(payload?.skills.some((s) => s.name === "deep-research")).toBe(false);
  });

  it("returns null when the Skills table has no Source column (older /context)", () => {
    const noSource = `## Context Usage

### Skills

| Skill | Tokens |
|-------|--------|
| obsidian | ~90 |
`;
    expect(parseSkillScopesFromContext(noSource, CAPTURED_AT)).toBeNull();
  });

  it("returns null when there are no scope-bearing skills", () => {
    const onlyBuiltins = `## Context Usage

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| deep-research | Built-in | ~120 |
| code-review | Built-in | ~100 |
`;
    expect(parseSkillScopesFromContext(onlyBuiltins, CAPTURED_AT)).toBeNull();
  });

  it("returns null when there is no Skills section at all", () => {
    const noSkills = `## Context Usage

**Tokens:** 21.9k / 1m (2%)
`;
    expect(parseSkillScopesFromContext(noSkills, CAPTURED_AT)).toBeNull();
  });
});

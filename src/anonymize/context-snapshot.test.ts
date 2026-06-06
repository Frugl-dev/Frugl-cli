import { describe, it, expect } from "vitest";
import { anonymize } from "./index.js";

// A realistic `claude -p "/context"` markdown breakdown with secrets PLANTED:
//   - an anthropic API key embedded in a Skills row,
//   - a third-party email in an MCP server row,
//   - a high-entropy token in an Agents row,
//   - user-identifying /Users/<name>/ memory-file paths.
// The breakdown only ever contains config identifiers (names) + paths + token
// counts — never file CONTENTS. SECRET_FILE_BODY is a sentinel that must never
// leak through anonymization because it was never in the input to begin with.
const SECRET_FILE_BODY = "TOP_SECRET_FILE_CONTENTS_THAT_MUST_NEVER_APPEAR";

const HOME = "/Users/dev";
const PLANTED_ANTHROPIC_KEY = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PLANTED_EMAIL = "teammate@acme.example";
const PLANTED_ENTROPY = "x8Kf9QmZ2pLvR7wNcB3hYtJ4sD6gA1eU0iO5";

const FIXTURE = `## Context Usage

**Model:** claude-opus-4-8[1m]
**Tokens:** 21.9k / 1m (2%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.6k | 0.3% |
| Memory files | 2.1k | 0.2% |
| Skills | 2.9k | 0.3% |
| Free space | 978.1k | 97.8% |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| Project | ${HOME}/projects/acme-app/CLAUDE.md | 14 |
| Project | ${HOME}/projects/acme-app/AGENTS.md | 2.1k |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| find-skills | User | ~110 |
| supabase token=${PLANTED_ANTHROPIC_KEY} | Project | ~160 |
| vitest | Project | ~60 |
| review | Built-in | < 20 |

### MCP Servers

| Server | Owner | Tokens |
|--------|-------|--------|
| github (${PLANTED_EMAIL}) | User | ~80 |

### Agents

| Agent | Token | Tokens |
|-------|-------|--------|
| code-reviewer ${PLANTED_ENTROPY} | Project | ~40 |
`;

describe("context snapshot anonymization (planted secrets)", () => {
  const result = anonymize(FIXTURE, {
    uploadId: "2026-06-06T09:00:00.000Z",
    ownerEmail: "owner@example.com",
    homeDir: HOME,
  });
  const out = String(result.payload);

  it("redacts the planted anthropic key in the Skills row", () => {
    expect(out).not.toContain(PLANTED_ANTHROPIC_KEY);
    expect(out).toContain("<REDACTED:anthropic-key>");
  });

  it("redacts the planted third-party email", () => {
    expect(out).not.toContain(PLANTED_EMAIL);
  });

  it("redacts the planted high-entropy token", () => {
    expect(out).not.toContain(PLANTED_ENTROPY);
    expect(out).toContain("<REDACTED:entropy-fallback>");
  });

  it("normalizes the user-identifying home path prefix", () => {
    // The /Users/<name>/ prefix is stripped; the home dir must not survive.
    expect(out).not.toContain(HOME);
  });

  it("preserves skill / MCP / agent names as config identifiers", () => {
    expect(out).toContain("find-skills");
    expect(out).toContain("supabase");
    expect(out).toContain("vitest");
    expect(out).toContain("review");
    expect(out).toContain("github");
    expect(out).toContain("code-reviewer");
  });

  it("preserves the memory-file path tails (config identifiers, minus the home prefix)", () => {
    // The repo-relative path under the home dir is kept so snapshots stay
    // comparable; only the user-identifying home prefix is normalized.
    expect(out).toContain("projects/acme-app/CLAUDE.md");
    expect(out).toContain("projects/acme-app/AGENTS.md");
  });

  it("never emits the contents of any referenced file", () => {
    // The input only ever carried paths + token counts, so the sentinel can
    // never appear — this guards against any future change that reads files.
    expect(FIXTURE).not.toContain(SECRET_FILE_BODY);
    expect(out).not.toContain(SECRET_FILE_BODY);
  });

  it("counts the redactions it made", () => {
    expect(result.redactionsByCategory["anthropic-key"]).toBeGreaterThanOrEqual(1);
    expect(result.redactionsByCategory["third-party-email"]).toBeGreaterThanOrEqual(1);
    expect(result.redactionsByCategory["entropy-fallback"]).toBeGreaterThanOrEqual(1);
    expect(result.redactionsByCategory["home-path"]).toBeGreaterThanOrEqual(1);
  });
});

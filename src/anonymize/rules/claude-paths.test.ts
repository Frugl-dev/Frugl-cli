import { describe, it, expect } from "vitest";
import { PseudonymTable } from "../pseudonyms.js";
import { claudePathsRule } from "./claude-paths.js";
import type { RuleContext } from "./types.js";

const HOME = "/Users/alice";

function makeCtx(): RuleContext {
  return {
    pseudonyms: new PseudonymTable("u-paths"),
    ownerEmail: "owner@example.com",
    homeDir: HOME,
  };
}

describe("claudePathsRule", () => {
  it("has the expected id and categories", () => {
    expect(claudePathsRule.id).toBe("claude-paths");
    expect(claudePathsRule.categories).toEqual(["home-path", "project-name"]);
  });

  it("redacts the home prefix and pseudonymizes the project name", () => {
    const input = `opened ${HOME}/.claude/projects/acme-secret/main.ts`;
    const { output, counts } = claudePathsRule.apply(input, makeCtx());
    expect(output).not.toContain(HOME);
    expect(output).not.toContain("acme-secret");
    expect(output).toContain("<HOME>");
    expect(output).toMatch(/proj_[a-f0-9]+/);
    expect(counts["home-path"]).toBe(1);
    expect(counts["project-name"]).toBe(1);
  });

  it("is a no-op on input without the home prefix", () => {
    const benign = "a path /var/log/system.log unrelated to home";
    const { output, counts } = claudePathsRule.apply(benign, makeCtx());
    expect(output).toBe(benign);
    expect(Object.keys(counts)).toHaveLength(0);
  });

  it("uses stable pseudonyms for the same project within one context", () => {
    const ctx = makeCtx();
    const a = claudePathsRule.apply(`${HOME}/.claude/projects/acme/a.ts`, ctx).output;
    const b = claudePathsRule.apply(`${HOME}/.claude/projects/acme/b.ts`, ctx).output;
    const projA = a.match(/proj_[a-f0-9]+/)?.[0];
    const projB = b.match(/proj_[a-f0-9]+/)?.[0];
    expect(projA).toBeDefined();
    expect(projA).toBe(projB);
  });

  it("reduces an absolute-path memory file to just the filename", () => {
    const input = `${HOME}/.claude/projects/-Users-alice-Documents-Projects-Acme/memory/MEMORY.md is loaded`;
    const { output } = claudePathsRule.apply(input, makeCtx());
    expect(output).toBe("MEMORY.md is loaded");
  });

  it("reduces a tilde-prefixed memory file to just the filename", () => {
    const input = `~/.claude/projects/-Users-alice-Documents-Projects-Acme/memory/MEMORY.md is loaded`;
    const { output, counts } = claudePathsRule.apply(input, makeCtx());
    expect(output).toBe("MEMORY.md is loaded");
    expect(counts["home-path"]).toBe(1);
    expect(counts["project-name"]).toBe(1);
  });

  it("works for any .md file in the memory directory", () => {
    const input = `~/.claude/projects/secret-proj/memory/notes.md`;
    const { output } = claudePathsRule.apply(input, makeCtx());
    expect(output).toBe("notes.md");
  });
});

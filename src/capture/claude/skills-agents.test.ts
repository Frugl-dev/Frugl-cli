import { describe, it, expect } from "vitest";
import { enumerateSkillsAgents } from "./skills-agents.js";
import type { CaptureIO } from "./io.js";

// A fake IO backed by an in-memory dir → entries map. Only join/isDir/readDir
// are exercised here.
function fakeIO(tree: Record<string, string[]>): CaptureIO {
  return {
    run: () => ({ stdout: "", status: 0 }),
    readFile: () => {
      throw new Error("skills-agents must never read file contents");
    },
    readDir: (path) => tree[path] ?? [],
    isDir: (path) => path in tree,
    homedir: () => "/home/u",
    cwd: () => "/work",
    join: (...parts) => parts.join("/"),
  };
}

describe("enumerateSkillsAgents", () => {
  it("collects skills (dirs), commands (.md), and agents (.md) with their source", () => {
    const io = fakeIO({
      "/home/u/.claude/skills": ["my-skill", "another-skill"],
      "/home/u/.claude/commands": ["deploy.md", "notes.md"],
      "/p/superpowers/agents": ["reviewer.md"],
    });

    const result = enumerateSkillsAgents(io, [
      { source: "user", dir: "/home/u/.claude" },
      { source: "plugin:superpowers", dir: "/p/superpowers" },
    ]);

    expect(result.parseStatus).toBe("parsed");
    expect(result.items).toEqual([
      { name: "my-skill", kind: "skill", source: "user" },
      { name: "another-skill", kind: "skill", source: "user" },
      { name: "deploy", kind: "slash_command", source: "user" },
      { name: "notes", kind: "slash_command", source: "user" },
      { name: "reviewer", kind: "agent", source: "plugin:superpowers" },
    ]);
  });

  it("skips dotfiles and non-.md files in command/agent dirs", () => {
    const io = fakeIO({
      "/home/u/.claude/commands": [".DS_Store", "README.txt", "real.md"],
    });
    const result = enumerateSkillsAgents(io, [{ source: "user", dir: "/home/u/.claude" }]);
    expect(result.items).toEqual([{ name: "real", kind: "slash_command", source: "user" }]);
  });

  it("returns an empty inventory when no roots have the subdirs", () => {
    const io = fakeIO({});
    const result = enumerateSkillsAgents(io, [{ source: "user", dir: "/home/u/.claude" }]);
    expect(result.items).toEqual([]);
    expect(result.parseStatus).toBe("parsed");
  });
});

import { describe, it, expect } from "vitest";
import { assembleClaudeConfig } from "./index.js";
import type { CaptureIO, CommandResult } from "./io.js";

interface FakeOpts {
  mcp?: CommandResult;
  plugins?: CommandResult;
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
}

function fakeIO(opts: FakeOpts): CaptureIO {
  const files = opts.files ?? {};
  const dirs = opts.dirs ?? {};
  return {
    run: (cmd, args) => {
      if (cmd === "claude" && args[0] === "mcp") return opts.mcp ?? { stdout: "", status: 0 };
      if (cmd === "claude" && args[0] === "plugin")
        return opts.plugins ?? { stdout: "", status: 0 };
      return { stdout: "", status: 1 };
    },
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    readDir: (path) => dirs[path] ?? [],
    isDir: (path) => path in dirs,
    homedir: () => "/home/u",
    cwd: () => "/work",
    join: (...parts) => parts.join("/"),
  };
}

const NOW = "2026-05-30T12:00:00.000Z";

describe("assembleClaudeConfig", () => {
  it("assembles all four categories from a healthy environment", () => {
    const io = fakeIO({
      mcp: { stdout: "plugin:pw:pw: npx @playwright/mcp@latest - ✓ Connected", status: 0 },
      plugins: {
        stdout:
          "  ❯ base@amplitude-internal\n    Version: 1.3.2\n    Scope: managed\n    Status: ✔ enabled",
        status: 0,
      },
      files: {
        "/home/u/.claude/settings.json": JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }],
          },
        }),
        "/home/u/.claude/plugins/cache/amplitude-internal/base/1.3.2/hooks/hooks.json":
          JSON.stringify({
            PostToolUse: [{ hooks: [{ type: "command", command: "echo plugin" }] }],
          }),
      },
      dirs: {
        "/home/u/.claude/plugins/cache/amplitude-internal/base/1.3.2": [],
        "/home/u/.claude/skills": ["my-skill"],
        "/home/u/.claude/plugins/cache/amplitude-internal/base/1.3.2/commands": ["deploy.md"],
      },
    });

    const capture = assembleClaudeConfig({ io, now: () => NOW });

    expect(capture.sourceTool).toBe("claude-code");
    expect(capture.capturedAt).toBe(NOW);
    expect(capture.mcpServers.items).toHaveLength(1);
    expect(capture.plugins.items[0]?.name).toBe("base@amplitude-internal");
    // hook from the user settings layer + the enabled plugin's hooks.json
    expect(capture.hooks.items.map((h: { source: string }) => h.source)).toEqual([
      "user-settings",
      "plugin:base@amplitude-internal",
    ]);
    // user skill + the enabled plugin's command
    expect(capture.skillsAgents.items).toEqual([
      { name: "my-skill", kind: "skill", source: "user" },
      { name: "deploy", kind: "slash_command", source: "plugin:base@amplitude-internal" },
    ]);
  });

  it("marks a category unparsed when its claude subprocess fails, keeping the rest", () => {
    const io = fakeIO({
      mcp: { stdout: "", status: 1 }, // e.g. claude errored
      plugins: { stdout: "  ❯ p@m\n    Status: ✔ enabled", status: 0 },
    });

    const capture = assembleClaudeConfig({ io, now: () => NOW });

    expect(capture.mcpServers.parseStatus).toBe("unparsed");
    expect(capture.mcpServers.items).toEqual([]);
    expect(capture.plugins.parseStatus).toBe("parsed");
    expect(capture.plugins.items).toHaveLength(1);
  });

  it("does not read hooks from a disabled plugin", () => {
    const io = fakeIO({
      plugins: {
        stdout: "  ❯ off@m\n    Version: 1.0.0\n    Scope: user\n    Status: disabled",
        status: 0,
      },
      files: {
        "/home/u/.claude/plugins/cache/m/off/1.0.0/hooks/hooks.json": JSON.stringify({
          Stop: [{ hooks: [{ type: "command", command: "echo nope" }] }],
        }),
      },
      dirs: { "/home/u/.claude/plugins/cache/m/off/1.0.0": [] },
    });

    const capture = assembleClaudeConfig({ io, now: () => NOW });

    expect(capture.hooks.items).toEqual([]);
  });
});

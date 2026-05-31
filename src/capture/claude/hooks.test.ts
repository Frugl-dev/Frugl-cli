import { describe, it, expect } from "vitest";
import { mergeHookSources, type HookConfigSource } from "./hooks.js";

describe("mergeHookSources", () => {
  it("merges across settings layers and plugin hooks, attributing the source", () => {
    const sources: HookConfigSource[] = [
      {
        source: "user-settings",
        config: {
          hooks: {
            PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo user" }] }],
          },
        },
      },
      {
        source: "project-settings",
        config: {
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "echo project" }] },
            ],
            Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
          },
        },
      },
      {
        // plugin hooks.json given as the event-map directly (no `hooks` wrapper)
        source: "plugin:superpowers",
        config: {
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo plugin" }] }],
        },
      },
    ];

    const result = mergeHookSources(sources);

    expect(result.parseStatus).toBe("parsed");
    expect(result.items).toEqual([
      { event: "PreToolUse", matcher: "*", command: "echo user", source: "user-settings" },
      { event: "PreToolUse", matcher: "Bash", command: "echo project", source: "project-settings" },
      { event: "Stop", matcher: null, command: "echo stop", source: "project-settings" },
      {
        event: "PostToolUse",
        matcher: "Edit",
        command: "echo plugin",
        source: "plugin:superpowers",
      },
    ]);
  });

  it("treats a settings file with no hooks key as empty, not unparsed", () => {
    const result = mergeHookSources([{ source: "user-settings", config: { permissions: {} } }]);
    expect(result.parseStatus).toBe("parsed");
    expect(result.items).toEqual([]);
  });

  it("flags the source unparsed when a config could not be read (null)", () => {
    const result = mergeHookSources([{ source: "project-settings-local", config: null }]);
    expect(result.parseStatus).toBe("unparsed");
    expect(result.items).toEqual([]);
  });

  it("captures a per-event count via repeated events for the same lifecycle", () => {
    const result = mergeHookSources([
      {
        source: "user-settings",
        config: {
          hooks: {
            PostToolUse: [
              {
                hooks: [
                  { type: "command", command: "a" },
                  { type: "command", command: "b" },
                ],
              },
            ],
          },
        },
      },
    ]);
    const postToolUse = result.items.filter((h: { event: string }) => h.event === "PostToolUse");
    expect(postToolUse).toHaveLength(2);
  });
});

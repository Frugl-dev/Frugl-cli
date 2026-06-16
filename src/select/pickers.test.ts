import { afterEach, describe, expect, it, vi } from "vitest";
import { checkbox } from "@inquirer/prompts";
import { selectProviders } from "./providers.js";
import { selectProjects } from "./projects.js";
import type { DetectedProvider } from "../sources/providers.js";
import type { ProjectGroup } from "../sources/providers.js";

vi.mock("@inquirer/prompts", () => ({
  checkbox: vi.fn<(config: { choices: unknown[] }) => Promise<string[]>>(),
}));
const checkboxMock = vi.mocked(checkbox);

afterEach(() => {
  checkboxMock.mockReset();
});

function detected(id: string, displayName: string, supported: boolean): DetectedProvider {
  return {
    descriptor: { id: id as never, displayName, supported, probe: async () => true },
  };
}

const detectedProviders = [
  detected("claude", "Claude Code", true),
  detected("cursor", "Cursor", false),
];

describe("selectProviders", () => {
  it("non-interactive: returns supported provider ids without prompting", async () => {
    const ids = await selectProviders(detectedProviders, { interactive: false });
    expect(ids).toEqual(["claude"]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });

  it("interactive: supported preselected+selectable, unsupported disabled", async () => {
    checkboxMock.mockResolvedValue(["claude"]);
    const ids = await selectProviders(detectedProviders, { interactive: true });
    expect(ids).toEqual(["claude"]);
    const choices = checkboxMock.mock.calls[0]![0].choices as unknown as Array<
      Record<string, unknown>
    >;
    const claude = choices.find((c) => c["value"] === "claude")!;
    const cursor = choices.find((c) => c["value"] === "cursor")!;
    expect(claude["checked"]).toBe(true);
    expect(claude["disabled"]).toBe(false);
    expect(cursor["checked"]).toBe(false);
    expect(cursor["disabled"]).toBeTruthy();
  });
});

const groups: ProjectGroup[] = [
  {
    providerId: "claude",
    projectId: "-Users-me-app",
    displayName: "/Users/me/app",
    sessions: [],
    sessionCount: 2,
  },
];

describe("selectProjects", () => {
  it("non-interactive: returns all project ids without prompting", async () => {
    const ids = await selectProjects(groups, { interactive: false });
    expect(ids).toEqual(["-Users-me-app"]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });

  it("interactive with no groups: returns [] without prompting", async () => {
    const ids = await selectProjects([], { interactive: true });
    expect(ids).toEqual([]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });

  it("interactive: every project preselected", async () => {
    checkboxMock.mockResolvedValue(["-Users-me-app"]);
    await selectProjects(groups, { interactive: true });
    const choices = checkboxMock.mock.calls[0]![0].choices as unknown as Array<
      Record<string, unknown>
    >;
    expect(choices[0]!["checked"]).toBe(true);
    expect(choices[0]!["value"]).toBe("-Users-me-app");
  });

  const twoGroups: ProjectGroup[] = [
    {
      providerId: "claude",
      projectId: "-Users-me-app",
      displayName: "/Users/me/app",
      sessions: [],
      sessionCount: 40,
    },
    {
      providerId: "claude",
      projectId: "-Users-me-scratch",
      displayName: "/Users/me/scratch",
      sessions: [],
      sessionCount: 12,
    },
  ];

  it("interactive: labels with cost-aware counts and drops empty projects", async () => {
    checkboxMock.mockResolvedValue(["-Users-me-app"]);
    const counts = new Map([
      ["-Users-me-app", 7],
      ["-Users-me-scratch", 0],
    ]);
    await selectProjects(twoGroups, { interactive: true, counts });
    const choices = checkboxMock.mock.calls[0]![0].choices as unknown as Array<
      Record<string, unknown>
    >;
    // Count comes from `counts`, not the raw sessionCount (40 / 12).
    expect(choices[0]!["name"]).toContain("(7)");
    expect(choices[0]!["checked"]).toBe(true);
    // A project with nothing left to upload is dropped entirely, not shown as "(0)".
    expect(choices).toHaveLength(1);
    expect(choices.some((c) => c["value"] === "-Users-me-scratch")).toBe(false);
  });

  it("interactive: all projects empty returns [] without prompting", async () => {
    const counts = new Map([
      ["-Users-me-app", 0],
      ["-Users-me-scratch", 0],
    ]);
    const ids = await selectProjects(twoGroups, { interactive: true, counts });
    expect(ids).toEqual([]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });

  it("interactive: deselect set leaves matching projects unchecked despite sessions", async () => {
    checkboxMock.mockResolvedValue([]);
    const counts = new Map([
      ["-Users-me-app", 7],
      ["-Users-me-scratch", 5],
    ]);
    await selectProjects(twoGroups, {
      interactive: true,
      counts,
      deselect: new Set(["-Users-me-scratch"]),
    });
    const choices = checkboxMock.mock.calls[0]![0].choices as unknown as Array<
      Record<string, unknown>
    >;
    // Has a remote (not in deselect) and sessions → checked.
    expect(choices[0]!["checked"]).toBe(true);
    // No remote (in deselect) but still has sessions → shown, unchecked.
    expect(choices[1]!["name"]).toContain("(5)");
    expect(choices[1]!["checked"]).toBe(false);
  });

  it("interactive: notes metadata-only tiering for cheap sessions in the prompt", async () => {
    checkboxMock.mockResolvedValue([]);
    await selectProjects(twoGroups, { interactive: true, minCost: 10 });
    const config = checkboxMock.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(config["message"]).toBe(
      "Which projects should Frugl upload? (sessions under $10.00 upload metadata only)",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkbox } from "@inquirer/prompts";
import { selectProjects } from "./projects.js";
import type { ProjectGroup } from "../sources/providers.js";

vi.mock("@inquirer/prompts", () => ({
  checkbox: vi.fn<(config: { message: string; choices: unknown[] }) => Promise<string[]>>(),
}));
const checkboxMock = vi.mocked(checkbox);

afterEach(() => {
  checkboxMock.mockReset();
});

function group(projectId: string, displayName: string, sessionCount: number): ProjectGroup {
  return { providerId: "claude", projectId, displayName, sessions: [], sessionCount };
}

type Choice = Record<string, unknown>;

function lastChoices(): Choice[] {
  return checkboxMock.mock.calls[0]![0].choices as unknown as Choice[];
}

const app = group("-Users-me-app", "/Users/me/app", 40);
const scratch = group("-Users-me-scratch", "/Users/me/scratch", 12);

describe("selectProjects (non-interactive)", () => {
  it("returns every project id without prompting", async () => {
    const ids = await selectProjects([app, scratch], { interactive: false });
    expect(ids).toEqual(["-Users-me-app", "-Users-me-scratch"]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });

  it("returns [] for no groups without prompting", async () => {
    expect(await selectProjects([], { interactive: false })).toEqual([]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });
});

describe("selectProjects (interactive)", () => {
  it("short-circuits to [] when given no groups", async () => {
    const ids = await selectProjects([], { interactive: true });
    expect(ids).toEqual([]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });

  it("labels each choice with its raw sessionCount when no counts override is supplied", async () => {
    checkboxMock.mockResolvedValue(["-Users-me-app"]);
    await selectProjects([app, scratch], { interactive: true });
    const choices = lastChoices();
    expect(choices[0]!["name"]).toBe("/Users/me/app  (40)");
    expect(choices[1]!["name"]).toBe("/Users/me/scratch  (12)");
    expect(choices.every((c) => c["checked"] === true)).toBe(true);
  });

  it("prefers cost-aware counts over sessionCount and drops zero-count groups", async () => {
    checkboxMock.mockResolvedValue(["-Users-me-app"]);
    const counts = new Map([
      ["-Users-me-app", 7],
      ["-Users-me-scratch", 0],
    ]);
    await selectProjects([app, scratch], { interactive: true, counts });
    const choices = lastChoices();
    expect(choices).toHaveLength(1);
    expect(choices[0]!["name"]).toBe("/Users/me/app  (7)");
    expect(choices.some((c) => c["value"] === "-Users-me-scratch")).toBe(false);
  });

  it("falls back to sessionCount when a group is missing from the counts map", async () => {
    checkboxMock.mockResolvedValue([]);
    const counts = new Map([["-Users-me-app", 3]]);
    await selectProjects([app, scratch], { interactive: true, counts });
    const choices = lastChoices();
    // app uses the override (3); scratch has no entry so falls back to 12.
    expect(choices[0]!["name"]).toBe("/Users/me/app  (3)");
    expect(choices[1]!["name"]).toBe("/Users/me/scratch  (12)");
  });

  it("returns [] without prompting when every group has nothing to upload", async () => {
    const counts = new Map([
      ["-Users-me-app", 0],
      ["-Users-me-scratch", 0],
    ]);
    const ids = await selectProjects([app, scratch], { interactive: true, counts });
    expect(ids).toEqual([]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });

  it("leaves deselected projects unchecked but still visible", async () => {
    checkboxMock.mockResolvedValue([]);
    await selectProjects([app, scratch], {
      interactive: true,
      deselect: new Set(["-Users-me-scratch"]),
    });
    const choices = lastChoices();
    expect(choices[0]!["checked"]).toBe(true);
    expect(choices[1]!["checked"]).toBe(false);
    expect(choices).toHaveLength(2);
  });

  it("uses the plain message when minCost is unset", async () => {
    checkboxMock.mockResolvedValue([]);
    await selectProjects([app], { interactive: true });
    expect(checkboxMock.mock.calls[0]![0].message).toBe("Which projects should Frugl upload?");
  });

  it("uses the plain message when minCost is zero", async () => {
    checkboxMock.mockResolvedValue([]);
    await selectProjects([app], { interactive: true, minCost: 0 });
    expect(checkboxMock.mock.calls[0]![0].message).toBe("Which projects should Frugl upload?");
  });

  it("annotates the message with the metadata-only threshold when minCost > 0", async () => {
    checkboxMock.mockResolvedValue([]);
    await selectProjects([app], { interactive: true, minCost: 10 });
    expect(checkboxMock.mock.calls[0]![0].message).toBe(
      "Which projects should Frugl upload? (sessions under $10.00 upload metadata only)",
    );
  });

  it("returns exactly what the prompt resolves to", async () => {
    checkboxMock.mockResolvedValue(["-Users-me-scratch"]);
    const ids = await selectProjects([app, scratch], { interactive: true });
    expect(ids).toEqual(["-Users-me-scratch"]);
  });
});

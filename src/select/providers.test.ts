import { afterEach, describe, expect, it, vi } from "vitest";
import { checkbox } from "@inquirer/prompts";
import { selectProviders } from "./providers.js";
import type { DetectedProvider, ProviderId } from "../sources/providers.js";

vi.mock("@inquirer/prompts", () => ({
  checkbox: vi.fn<(config: { message: string; choices: unknown[] }) => Promise<string[]>>(),
}));
const checkboxMock = vi.mocked(checkbox);

afterEach(() => {
  checkboxMock.mockReset();
});

function detected(id: ProviderId, displayName: string, supported: boolean): DetectedProvider {
  return {
    descriptor: { id, displayName, supported, probe: async () => true },
  };
}

type Choice = Record<string, unknown>;

function lastChoices(): Choice[] {
  return checkboxMock.mock.calls[0]![0].choices as unknown as Choice[];
}

describe("selectProviders (non-interactive)", () => {
  it("returns only supported provider ids and never prompts", async () => {
    const ids = await selectProviders(
      [
        detected("claude", "Claude Code", true),
        detected("cursor", "Cursor", false),
        detected("codex", "Codex", true),
      ],
      { interactive: false },
    );
    expect(ids).toEqual(["claude", "codex"]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });

  it("returns [] when nothing supported is detected", async () => {
    const ids = await selectProviders([detected("cursor", "Cursor", false)], {
      interactive: false,
    });
    expect(ids).toEqual([]);
  });

  it("returns [] for an empty detection list", async () => {
    expect(await selectProviders([], { interactive: false })).toEqual([]);
  });
});

describe("selectProviders (interactive)", () => {
  it("preselects supported and disables unsupported, returning the prompt result", async () => {
    checkboxMock.mockResolvedValue(["claude"]);
    const ids = await selectProviders(
      [detected("claude", "Claude Code", true), detected("cursor", "Cursor", false)],
      { interactive: true },
    );
    // The result is exactly what the prompt returned, not the derived supported set.
    expect(ids).toEqual(["claude"]);

    const choices = lastChoices();
    const claude = choices.find((c) => c["value"] === "claude")!;
    const cursor = choices.find((c) => c["value"] === "cursor")!;
    expect(claude["checked"]).toBe(true);
    expect(claude["disabled"]).toBe(false);
    expect(claude["name"]).toBe("Claude Code");
    expect(cursor["checked"]).toBe(false);
    expect(cursor["disabled"]).toBe("(not yet supported)");
    // Unsupported providers get a labelled name.
    expect(cursor["name"]).toBe("Cursor (not yet supported)");
  });

  it("renders a choice for every detected provider, supported or not", async () => {
    checkboxMock.mockResolvedValue([]);
    await selectProviders(
      [
        detected("claude", "Claude Code", true),
        detected("codex", "Codex", true),
        detected("cursor", "Cursor", false),
      ],
      { interactive: true },
    );
    expect(lastChoices()).toHaveLength(3);
  });

  it("still prompts (with no choices) when nothing is detected", async () => {
    checkboxMock.mockResolvedValue([]);
    const ids = await selectProviders([], { interactive: true });
    expect(ids).toEqual([]);
    expect(checkboxMock).toHaveBeenCalledTimes(1);
    expect(lastChoices()).toEqual([]);
  });

  it("uses the providers prompt message", async () => {
    checkboxMock.mockResolvedValue([]);
    await selectProviders([detected("claude", "Claude Code", true)], { interactive: true });
    expect(checkboxMock.mock.calls[0]![0].message).toBe("Which providers should Frugl upload?");
  });
});

import { describe, expect, it } from "vitest";
import { applySelection, type Selection } from "./selection.js";
import type { ProjectGroup } from "../sources/providers.js";
import type { SessionRef } from "../sources/types.js";

function ref(p: string): SessionRef {
  return { sourceKind: "claude-code", absolutePath: p, byteSizeOnDisk: 10, mtimeMs: 1 };
}

const groups: ProjectGroup[] = [
  {
    providerId: "claude",
    projectId: "-Users-me-app",
    displayName: "/Users/me/app",
    sessions: [ref("/a/1.jsonl"), ref("/a/2.jsonl")],
    sessionCount: 2,
  },
  {
    providerId: "claude",
    projectId: "-Users-me-scratch",
    displayName: "/Users/me/scratch",
    sessions: [ref("/s/3.jsonl")],
    sessionCount: 1,
  },
];

describe("applySelection", () => {
  it("includes only sessions whose provider AND project are selected", () => {
    const sel: Selection = { providerIds: ["claude"], projectIds: ["-Users-me-app"] };
    const refs = applySelection(groups, sel);
    expect(refs.map((r) => r.absolutePath)).toEqual(["/a/1.jsonl", "/a/2.jsonl"]);
  });

  it("returns everything when all providers and projects are selected", () => {
    const sel: Selection = {
      providerIds: ["claude"],
      projectIds: ["-Users-me-app", "-Users-me-scratch"],
    };
    expect(applySelection(groups, sel)).toHaveLength(3);
  });

  it("returns nothing when the provider is not selected", () => {
    const sel: Selection = { providerIds: [], projectIds: ["-Users-me-app"] };
    expect(applySelection(groups, sel)).toEqual([]);
  });

  it("returns nothing when no project is selected", () => {
    const sel: Selection = { providerIds: ["claude"], projectIds: [] };
    expect(applySelection(groups, sel)).toEqual([]);
  });
});

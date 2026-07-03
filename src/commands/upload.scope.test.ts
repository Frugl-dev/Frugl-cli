import { describe, expect, it } from "vitest";
import { groupMatchesScopeDir } from "./upload.js";
import type { ProjectGroup } from "../sources/providers.js";

function claudeGroup(projectId: string, displayName: string): ProjectGroup {
  return { providerId: "claude", projectId, displayName, sessions: [], sessionCount: 0 };
}

describe("groupMatchesScopeDir", () => {
  it("matches a claude project whose real directory name contains a hyphen", () => {
    // Regression: decodeProjectPath can't tell a literal "-" in "frugl-cli"
    // apart from an encoded "/", so matching on the decoded displayName missed
    // this project entirely and `frugl upload` reported "Nothing selected."
    const group = claudeGroup(
      "-Users-shmck-Documents-Projects-frugl-cli",
      "/Users/shmck/Documents/Projects/frugl/cli", // lossy decode — NOT the real path
    );
    expect(groupMatchesScopeDir(group, "/Users/shmck/Documents/Projects/frugl-cli")).toBe(true);
  });

  it("matches a subdirectory of the scoped project", () => {
    const group = claudeGroup(
      "-Users-shmck-Documents-Projects-frugl-cli-apps-web",
      "/Users/shmck/Documents/Projects/frugl/cli/apps/web",
    );
    expect(groupMatchesScopeDir(group, "/Users/shmck/Documents/Projects/frugl-cli")).toBe(true);
  });

  it("does not match an unrelated sibling project", () => {
    const group = claudeGroup(
      "-Users-shmck-Documents-Projects-other",
      "/Users/shmck/Documents/Projects/other",
    );
    expect(groupMatchesScopeDir(group, "/Users/shmck/Documents/Projects/frugl-cli")).toBe(false);
  });
});

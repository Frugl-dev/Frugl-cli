import { describe, it, expect } from "vitest";
import { parsePluginList } from "./plugins.js";

describe("parsePluginList", () => {
  it("parses name, version, scope, and enabled status per block", () => {
    const stdout = [
      "Installed plugins:",
      "",
      "  ❯ base@amplitude-internal",
      "    Version: 1.3.2",
      "    Scope: managed",
      "    Status: ✔ enabled",
      "",
      "  ❯ context7@claude-plugins-official",
      "    Version: unknown",
      "    Scope: user",
      "    Status: ✔ enabled",
    ].join("\n");

    const result = parsePluginList(stdout);

    expect(result.parseStatus).toBe("parsed");
    expect(result.items).toEqual([
      { name: "base@amplitude-internal", version: "1.3.2", scope: "managed", status: "enabled" },
      {
        name: "context7@claude-plugins-official",
        version: "unknown",
        scope: "user",
        status: "enabled",
      },
    ]);
  });

  it("preserves a literal 'unknown' version rather than fabricating one", () => {
    const result = parsePluginList(
      "  ❯ p@m\n    Version: unknown\n    Scope: user\n    Status: ✔ enabled",
    );
    expect(result.items[0]?.version).toBe("unknown");
  });

  it("defaults a block missing fields to disabled/unknown without erroring", () => {
    const result = parsePluginList("  ❯ bare@m");
    expect(result.parseStatus).toBe("parsed");
    expect(result.items[0]).toEqual({
      name: "bare@m",
      version: "unknown",
      scope: "unknown",
      status: "disabled",
    });
  });
});

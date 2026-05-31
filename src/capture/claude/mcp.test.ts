import { describe, it, expect } from "vitest";
import { parseMcpList } from "./mcp.js";

describe("parseMcpList", () => {
  it("parses name, transport, target, and status across the three glyphs", () => {
    const stdout = [
      "Checking MCP server health…",
      "",
      "plugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - ✗ Failed to connect",
      "plugin:playwright:playwright: npx @playwright/mcp@latest - ✓ Connected",
      "plugin:pending:pending: npx -y @some/server - ⏸ Pending approval",
    ].join("\n");

    const result = parseMcpList(stdout);

    expect(result.parseStatus).toBe("parsed");
    expect(result.items).toEqual([
      {
        name: "plugin:github:github",
        transport: "http",
        target: "https://api.githubcopilot.com/mcp/",
        status: "failed",
      },
      {
        name: "plugin:playwright:playwright",
        transport: "stdio",
        target: "npx @playwright/mcp@latest",
        status: "connected",
      },
      {
        name: "plugin:pending:pending",
        transport: "stdio",
        target: "npx -y @some/server",
        status: "pending",
      },
    ]);
  });

  it("ignores the health banner and blank lines without flagging", () => {
    const result = parseMcpList("Checking MCP server health…\n\n");
    expect(result.parseStatus).toBe("parsed");
    expect(result.items).toEqual([]);
  });

  it("flags the source unparsed on a malformed line but keeps the good ones", () => {
    const stdout = [
      "plugin:ok:ok: npx -y @ok/server - ✓ Connected",
      "this is not a server line at all",
    ].join("\n");

    const result = parseMcpList(stdout);

    expect(result.parseStatus).toBe("unparsed");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("plugin:ok:ok");
  });
});

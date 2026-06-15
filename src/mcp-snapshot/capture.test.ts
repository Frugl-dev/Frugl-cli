import { describe, it, expect } from "vitest";
import { captureMcpInventory, MCP_SCHEMA_VERSION, MCP_SOURCE_TOOL } from "./capture.js";
import type { CaptureIO, CommandResult } from "../capture/claude/io.js";
import { isFruglError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";

// A CaptureIO whose only used method is run(); the rest throw so a test that
// accidentally reaches the filesystem fails loudly.
function ioReturning(result: CommandResult): CaptureIO {
  return {
    run: () => result,
    readFile: () => {
      throw new Error("unexpected readFile");
    },
    readDir: () => [],
    isDir: () => false,
    homedir: () => "/home/test",
    cwd: () => "/home/test",
    join: (...parts) => parts.join("/"),
  };
}

const TWO_SERVERS = [
  "Checking MCP server health...",
  "",
  "plugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - ✗ Failed to connect",
  "local-fs: npx my-mcp - ✓ Connected",
  "",
].join("\n");

describe("captureMcpInventory", () => {
  it("parses the full inventory (name, transport, target, status) at a stamped time", () => {
    const inv = captureMcpInventory({
      io: ioReturning({ stdout: TWO_SERVERS, status: 0 }),
      now: () => "2026-06-06T09:00:00.000Z",
    });

    expect(inv.schemaVersion).toBe(MCP_SCHEMA_VERSION);
    expect(inv.sourceTool).toBe(MCP_SOURCE_TOOL);
    expect(inv.capturedAt).toBe("2026-06-06T09:00:00.000Z");
    expect(inv.parseStatus).toBe("parsed");
    expect(inv.mcpServers).toEqual([
      {
        name: "plugin:github:github",
        transport: "http",
        target: "https://api.githubcopilot.com/mcp/",
        status: "failed",
      },
      { name: "local-fs", transport: "stdio", target: "npx my-mcp", status: "connected" },
    ]);
  });

  it("flags parseStatus unparsed on a line it cannot read, retaining what it can", () => {
    const stdout = ["local-fs: npx my-mcp - ✓ Connected", "this line is junk"].join("\n");
    const inv = captureMcpInventory({
      io: ioReturning({ stdout, status: 0 }),
      now: () => "2026-06-06T09:00:00.000Z",
    });
    expect(inv.parseStatus).toBe("unparsed");
    expect(inv.mcpServers).toHaveLength(1);
  });

  it("fail-closed: a non-zero `claude mcp list` exit throws (no inventory)", () => {
    let caught: unknown;
    try {
      captureMcpInventory({ io: ioReturning({ stdout: "", status: 1 }) });
    } catch (err) {
      caught = err;
    }
    expect(isFruglError(caught)).toBe(true);
    expect((caught as { exitCode?: number }).exitCode).toBe(EXIT.GENERIC_FAILURE);
  });
});

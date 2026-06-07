import { describe, it, expect } from "vitest";
import { captureDeclaredMcpServers } from "./mcp-inventory.js";
import { defaultIO, type CaptureIO } from "./io.js";

function ioWith(run: CaptureIO["run"]): CaptureIO {
  return { ...defaultIO, run };
}

const LIST_STDOUT = [
  "Checking MCP server health…",
  "",
  "playwright: npx @playwright/mcp@latest - ✓ Connected",
  "github: https://api.githubcopilot.com/mcp/ (HTTP) - ✗ Failed to connect",
  "pending-one: npx -y @some/server - ⏸ Pending approval",
].join("\n");

describe("captureDeclaredMcpServers", () => {
  it("maps `claude mcp list` to names-only {name, status} — no transport/target", () => {
    const io = ioWith(() => ({ stdout: LIST_STDOUT, status: 0 }));
    expect(captureDeclaredMcpServers(io)).toEqual([
      { name: "playwright", status: "connected" },
      { name: "github", status: "failed" },
      { name: "pending-one", status: "pending" },
    ]);
  });

  it("returns undefined when the subprocess exits non-zero (fail-open)", () => {
    const io = ioWith(() => ({ stdout: "", status: 1 }));
    expect(captureDeclaredMcpServers(io)).toBeUndefined();
  });

  it("returns undefined when the subprocess throws (missing binary)", () => {
    const io = ioWith(() => {
      throw new Error("ENOENT");
    });
    expect(captureDeclaredMcpServers(io)).toBeUndefined();
  });

  it("returns undefined when no servers are configured", () => {
    const io = ioWith(() => ({ stdout: "Checking MCP server health…\n\n", status: 0 }));
    expect(captureDeclaredMcpServers(io)).toBeUndefined();
  });

  it("dedupes repeated server names", () => {
    const stdout = [
      "playwright: npx @playwright/mcp@latest - ✓ Connected",
      "playwright: npx @playwright/mcp@latest - ✓ Connected",
    ].join("\n");
    const io = ioWith(() => ({ stdout, status: 0 }));
    expect(captureDeclaredMcpServers(io)).toEqual([{ name: "playwright", status: "connected" }]);
  });
});

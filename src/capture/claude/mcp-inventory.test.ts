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

describe("captureDeclaredMcpServers — per-source commands (codex/gemini)", () => {
  it("codex: runs `codex mcp list --json` and parses the JSON array (status unknown)", () => {
    const io = ioWith((cmd, args) => {
      expect(cmd).toBe("codex");
      expect(args).toEqual(["mcp", "list", "--json"]);
      return { status: 0, stdout: '[{"name":"railway"},{"name":"supabase"}]' };
    });
    expect(captureDeclaredMcpServers(io, "codex")).toEqual([
      { name: "railway", status: "unknown" },
      { name: "supabase", status: "unknown" },
    ]);
  });

  it("codex: an empty or non-array JSON payload yields undefined (fail-open)", () => {
    const empty = ioWith(() => ({ status: 0, stdout: "[]" }));
    expect(captureDeclaredMcpServers(empty, "codex")).toBeUndefined();
    const junk = ioWith(() => ({ status: 0, stdout: "not json" }));
    expect(captureDeclaredMcpServers(junk, "codex")).toBeUndefined();
  });

  it("gemini: routes `gemini mcp list` through the text parser", () => {
    const io = ioWith((cmd, args) => {
      expect(cmd).toBe("gemini");
      expect(args).toEqual(["mcp", "list"]);
      return { status: 0, stdout: "railway: npx railway-mcp - ✓ Connected\n" };
    });
    expect(captureDeclaredMcpServers(io, "gemini")).toEqual([
      { name: "railway", status: "connected" },
    ]);
  });

  it("gemini: an unrecognized text format degrades to undefined (never wrong data)", () => {
    const io = ioWith(() => ({ status: 0, stdout: "No MCP servers configured.\n" }));
    expect(captureDeclaredMcpServers(io, "gemini")).toBeUndefined();
  });

  it("sources with no registered inventory command yield undefined", () => {
    const io = ioWith(() => {
      throw new Error("must not be called");
    });
    expect(captureDeclaredMcpServers(io, "cursor")).toBeUndefined();
  });
});

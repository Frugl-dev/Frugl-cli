import { describe, it, expect } from "vitest";
import { buildMcpSnapshotDocument, captureMcpSnapshot, MCP_FORMAT_VERSION } from "./mcp-capture.js";
import { anonymize } from "../anonymize/index.js";
import type { CaptureIO, CommandResult } from "../capture/claude/io.js";

// A secret embedded in an MCP server target (a launch command). The anonymizer
// must scrub it; the server NAME must survive as a config identifier.
const PLANTED_KEY = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const LIST = [
  "Checking MCP server health...",
  "plugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - ✗ Failed to connect",
  `local-secret: npx my-mcp --api-key=${PLANTED_KEY} - ✓ Connected`,
].join("\n");

function fakeIO(run: CommandResult): CaptureIO {
  return {
    run: () => run,
    readFile: () => {
      throw new Error("unused");
    },
    readDir: () => [],
    isDir: () => false,
    homedir: () => "/Users/dev",
    cwd: () => "/Users/dev/proj",
    join: (...p) => p.join("/"),
  };
}

describe("captureMcpSnapshot", () => {
  it("captures the full per-server inventory and stamps capturedAt", () => {
    const capture = captureMcpSnapshot({
      io: fakeIO({ stdout: LIST, status: 0 }),
      now: () => "2026-06-06T09:00:00.000Z",
    });
    expect(capture.tool).toBe("claude-code");
    expect(capture.capturedAt).toBe("2026-06-06T09:00:00.000Z");
    expect(capture.parseStatus).toBe("parsed");
    expect(capture.servers).toEqual([
      {
        name: "plugin:github:github",
        transport: "http",
        target: "https://api.githubcopilot.com/mcp/",
        status: "failed",
      },
      {
        name: "local-secret",
        transport: "stdio",
        target: `npx my-mcp --api-key=${PLANTED_KEY}`,
        status: "connected",
      },
    ]);
  });

  it("fail-closed: a non-zero `claude mcp list` throws, no partial capture", () => {
    expect(() => captureMcpSnapshot({ io: fakeIO({ stdout: "", status: 1 }) })).toThrow(
      /could not run 'claude mcp list'/i,
    );
  });

  it("fail-closed: a zero-server inventory throws (nothing to snapshot)", () => {
    expect(() =>
      captureMcpSnapshot({ io: fakeIO({ stdout: "Checking MCP server health...\n", status: 0 }) }),
    ).toThrow(/no mcp servers/i);
  });

  it("the anonymized document scrubs target secrets but keeps server names", () => {
    const capture = captureMcpSnapshot({
      io: fakeIO({ stdout: LIST, status: 0 }),
      now: () => "2026-06-06T09:00:00.000Z",
    });
    const doc = buildMcpSnapshotDocument(capture);
    expect(doc.schemaVersion).toBe(1);

    const result = anonymize(doc, {
      uploadId: "2026-06-06T09:00:00.000Z",
      ownerEmail: "owner@example.com",
    });
    const serialized = JSON.stringify(result.payload);

    // Secret scrubbed…
    expect(serialized).not.toContain(PLANTED_KEY);
    // …config identifiers preserved.
    expect(serialized).toContain("plugin:github:github");
    expect(serialized).toContain("local-secret");
  });
});

describe("MCP_FORMAT_VERSION", () => {
  it("is the routed mcp parse-path version", () => {
    expect(MCP_FORMAT_VERSION).toBe("mcp/v1");
  });
});

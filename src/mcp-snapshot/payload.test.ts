import { describe, it, expect } from "vitest";
import { buildMcpPayload } from "./payload.js";
import type { McpInventory } from "./capture.js";

function inventory(capturedAt: string): McpInventory {
  return {
    schemaVersion: 1,
    sourceTool: "claude-code",
    capturedAt,
    parseStatus: "parsed",
    mcpServers: [
      {
        name: "plugin:github:github",
        transport: "http",
        target: "https://api.githubcopilot.com/mcp/",
        status: "failed",
      },
      { name: "local-fs", transport: "stdio", target: "npx my-mcp", status: "connected" },
    ],
  };
}

const opts = (uploadId = "id-A") => ({ uploadId, ownerEmail: "owner@example.com" });

function parseBody(payload: ReturnType<typeof buildMcpPayload>): Record<string, unknown> {
  return JSON.parse(payload.body.toString("utf8"));
}

describe("buildMcpPayload", () => {
  it("emits a JSON body carrying schemaVersion, sourceTool, capturedAt, parseStatus, and the servers", () => {
    const payload = buildMcpPayload(inventory("2026-06-06T09:00:00.000Z"), opts());
    const doc = parseBody(payload);

    expect(doc.schemaVersion).toBe(1);
    expect(doc.sourceTool).toBe("claude-code");
    // capturedAt is grafted back onto the scrubbed document for the body.
    expect(doc.capturedAt).toBe("2026-06-06T09:00:00.000Z");
    expect(doc.parseStatus).toBe("parsed");
    expect(Array.isArray(doc.mcpServers)).toBe(true);
    expect((doc.mcpServers as unknown[]).length).toBe(2);
    // byteSize matches the actual bytes we PUT.
    expect(payload.byteSize).toBe(payload.body.byteLength);
  });

  it("preserves server names + non-secret targets (anonymizer leaves these untouched)", () => {
    const payload = buildMcpPayload(inventory("2026-06-06T09:00:00.000Z"), opts());
    const doc = parseBody(payload);
    expect(doc.mcpServers).toEqual([
      {
        name: "plugin:github:github",
        transport: "http",
        target: "https://api.githubcopilot.com/mcp/",
        status: "failed",
      },
      { name: "local-fs", transport: "stdio", target: "npx my-mcp", status: "connected" },
    ]);
  });

  it("scrubs a secret embedded in a server target before it leaves the machine", () => {
    const inv = inventory("2026-06-06T09:00:00.000Z");
    inv.mcpServers = [
      {
        name: "secret-fs",
        transport: "stdio",
        target: "npx my-mcp --api-key=sk-abcdef0123456789abcdef0123456789",
        status: "connected",
      },
    ];
    const payload = buildMcpPayload(inv, opts());
    const target = (parseBody(payload).mcpServers as Array<{ target: string }>)[0]!.target;
    expect(target).not.toContain("sk-abcdef0123456789abcdef0123456789");
  });

  it("content_hash is stable across capture timestamps but sensitive to the servers (no-change gate)", () => {
    // Same servers, different capturedAt AND uploadId → identical content hash, so
    // the server's no-change gate (spec 052) can fire.
    const a = buildMcpPayload(inventory("2026-06-06T09:00:00.000Z"), opts("id-A"));
    const b = buildMcpPayload(inventory("2026-06-06T23:30:00.000Z"), opts("id-B"));
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.contentHash).toBe(a.contentHash);

    // A changed inventory → different hash → would upload.
    const changed = inventory("2026-06-06T09:00:00.000Z");
    changed.mcpServers = changed.mcpServers.slice(0, 1);
    const c = buildMcpPayload(changed, opts("id-C"));
    expect(c.contentHash).not.toBe(a.contentHash);
  });
});

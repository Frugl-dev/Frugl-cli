import { describe, it, expect } from "vitest";
import { MCP_FORMAT_VERSION, uploadMcpSnapshot, type McpUploadResult } from "./upload.js";
import { buildMcpPayload } from "./payload.js";
import type { McpInventory } from "./capture.js";
import { InMemoryCloud } from "../upload/in-memory-cloud.js";

function inventory(capturedAt = "2026-06-06T09:00:00.000Z"): McpInventory {
  return {
    schemaVersion: 1,
    sourceTool: "claude-code",
    capturedAt,
    parseStatus: "parsed",
    mcpServers: [
      { name: "local-fs", transport: "stdio", target: "npx my-mcp", status: "connected" },
    ],
  };
}

function payloadFor(capturedAt?: string, uploadId = "id-A") {
  return buildMcpPayload(inventory(capturedAt), { uploadId, ownerEmail: "owner@example.com" });
}

const baseInput = (cloud: InMemoryCloud, capturedAt = "2026-06-06T09:00:00.000Z") => ({
  cloud,
  cliVersion: "1.2.3",
  sourceKind: "claude-code",
  capturedAt,
  payload: payloadFor(capturedAt),
});

function expectUploaded(r: McpUploadResult): Extract<McpUploadResult, { status: "uploaded" }> {
  if (r.status !== "uploaded") throw new Error(`expected uploaded, got ${r.status}`);
  return r;
}

describe("uploadMcpSnapshot", () => {
  it("sends an mcp_snapshot manifest with one timestamped, fingerprinted mcp/v1 entry", async () => {
    const cloud = new InMemoryCloud();
    await uploadMcpSnapshot(baseInput(cloud));

    const manifest = [...cloud.manifests.values()][0];
    expect(manifest).toBeDefined();
    expect(manifest!.artifact_kind).toBe("mcp_snapshot");
    expect(manifest!.source_kind).toBe("claude-code");
    expect(manifest!.expected_session_count).toBe(1);
    expect(manifest!.cli_version).toBe("1.2.3");
    // The mcp inventory rides the PUT body, not the manifest mcp_servers rider.
    expect(manifest).not.toHaveProperty("mcp_servers");

    const entry = manifest!.sessions[0]!;
    expect(entry.format_version).toBe(MCP_FORMAT_VERSION);
    expect(entry.captured_at).toBe("2026-06-06T09:00:00.000Z");
    expect(entry.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("PUTs the anonymized inventory as JSON bytes", async () => {
    const cloud = new InMemoryCloud();
    const input = baseInput(cloud);
    const upload = expectUploaded(await uploadMcpSnapshot(input));

    const body = cloud.puttedBodies.get(upload.sessionId);
    expect(body).toBeDefined();
    const doc = JSON.parse(Buffer.from(body!).toString("utf8"));
    expect(doc.sourceTool).toBe("claude-code");
    expect(doc.mcpServers).toEqual([
      { name: "local-fs", transport: "stdio", target: "npx my-mcp", status: "connected" },
    ]);
    // expected_bytes on the manifest matches the bytes actually PUT.
    expect(Buffer.from(body!).byteLength).toBe(input.payload.byteSize);
  });

  it("skips the upload when the server reports no_change (spec 052)", async () => {
    const cloud = new InMemoryCloud({ manifestNoChange: true });
    const r = await uploadMcpSnapshot(baseInput(cloud));
    expect(r).toEqual({ status: "no_change" });
    expect(cloud.presignedSessions).toHaveLength(0);
    expect(cloud.puttedBodies.size).toBe(0);
  });

  it("returns cap_reached and uploads nothing when over the weekly cap (spec 052)", async () => {
    const cloud = new InMemoryCloud({
      manifestCapReached: { cap: 7, used: 7, windowResetsAt: "2026-06-21T00:00:00.000Z" },
    });
    const r = await uploadMcpSnapshot(baseInput(cloud));
    expect(r).toEqual({
      status: "cap_reached",
      cap: 7,
      used: 7,
      windowResetsAt: "2026-06-21T00:00:00.000Z",
    });
    expect(cloud.presignedSessions).toHaveLength(0);
    expect(cloud.puttedBodies.size).toBe(0);
  });
});

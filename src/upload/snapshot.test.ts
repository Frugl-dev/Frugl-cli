import { describe, expect, it } from "vitest";
import { InMemoryCloud } from "./in-memory-cloud.js";
import { CloudPortError } from "./cloud-port.js";
import { uploadSnapshot, type SnapshotUploadInput } from "./snapshot.js";

const BODY = new TextEncoder().encode("anonymized-snapshot-bytes");

function baseInput(
  cloud: InMemoryCloud,
  overrides: Partial<SnapshotUploadInput> = {},
): SnapshotUploadInput {
  return {
    cloud,
    cliVersion: "0.1.0",
    sourceKind: "context",
    policyVersion: "v0.1",
    capturedAt: "2026-06-21T00:00:00.000Z",
    artifactKind: "context_snapshot",
    formatVersion: "context/v1",
    body: BODY,
    byteSize: 999, // deliberately != body length to assert it rides through distinctly.
    contentHash: "f".repeat(64),
    redactionSummary: { email: 2, secret: 0 },
    ...overrides,
  };
}

describe("uploadSnapshot", () => {
  it("runs the full create → presign → PUT → complete handshake and reports uploaded", async () => {
    const cloud = new InMemoryCloud({ manifestId: "mfst-snap" });
    const result = await uploadSnapshot(baseInput(cloud));

    expect(result).toMatchObject({ status: "uploaded", manifestId: "mfst-snap" });
    if (result.status !== "uploaded") throw new Error("expected uploaded");
    expect(result.dashboardUrl).toBe("/dashboard?upload=mfst-snap");

    // Exactly one session minted, presigned, and PUT.
    const req = cloud.manifests.get("mfst-snap")!;
    expect(req.expected_session_count).toBe(1);
    expect(req.sessions).toHaveLength(1);
    const sessionId = req.sessions[0]!.session_id;
    expect(result.sessionId).toBe(sessionId);
    expect(cloud.presignedSessions).toEqual([sessionId]);
    expect(cloud.puttedBodies.get(sessionId)).toEqual(BODY);
  });

  it("forwards the byteSize, contentHash, capturedAt and formatVersion onto the manifest session", async () => {
    const cloud = new InMemoryCloud({ manifestId: "m1" });
    await uploadSnapshot(baseInput(cloud));
    const session = cloud.manifests.get("m1")!.sessions[0]!;
    expect(session.expected_bytes).toBe(999);
    expect(session.content_hash).toBe("f".repeat(64));
    expect(session.captured_at).toBe("2026-06-21T00:00:00.000Z");
    expect(session.format_version).toBe("context/v1");
  });

  it("filters out zero-count redaction categories before completing", async () => {
    const cloud = new InMemoryCloud({ manifestId: "m2" });
    let received: Record<string, number> | undefined;
    const original = cloud.completeManifest.bind(cloud);
    cloud.completeManifest = (id, summary) => {
      received = summary;
      return original(id, summary);
    };
    await uploadSnapshot(baseInput(cloud, { redactionSummary: { email: 2, secret: 0, key: 1 } }));
    expect(received).toEqual({ email: 2, key: 1 });
  });

  it("includes mcp_servers on the manifest only when non-empty", async () => {
    const servers = [
      { name: "srv-a", status: "connected" as const },
      { name: "srv-b", status: "failed" as const },
    ];
    const cloud = new InMemoryCloud({ manifestId: "m3" });
    await uploadSnapshot(baseInput(cloud, { mcpServers: servers }));
    expect(cloud.manifests.get("m3")!.mcp_servers).toEqual(servers);

    const cloud2 = new InMemoryCloud({ manifestId: "m3b" });
    await uploadSnapshot(baseInput(cloud2, { mcpServers: [] }));
    expect(cloud2.manifests.get("m3b")!.mcp_servers).toBeUndefined();
  });

  it("includes skill_scopes on the manifest only when there are skills", async () => {
    const skillScopes = {
      schema: "frugl.skill-scopes" as const,
      schema_version: 1 as const,
      captured_at: "2026-06-21T00:00:00.000Z",
      provider: "claude_code" as const,
      skills: [{ name: "obsidian", scope: "user" as const, project_key: null }],
    };
    const cloud = new InMemoryCloud({ manifestId: "m4" });
    await uploadSnapshot(baseInput(cloud, { skillScopes }));
    expect(cloud.manifests.get("m4")!.skill_scopes).toEqual(skillScopes);

    const cloud2 = new InMemoryCloud({ manifestId: "m4b" });
    await uploadSnapshot(baseInput(cloud2, { skillScopes: { ...skillScopes, skills: [] } }));
    expect(cloud2.manifests.get("m4b")!.skill_scopes).toBeUndefined();
  });

  it("no_change gate short-circuits before any presign or PUT", async () => {
    const cloud = new InMemoryCloud({ manifestId: "m5", manifestNoChange: true });
    const result = await uploadSnapshot(baseInput(cloud));
    expect(result).toEqual({ status: "no_change" });
    expect(cloud.presignedSessions).toHaveLength(0);
    expect(cloud.puttedBodies.size).toBe(0);
  });

  it("cap_reached gate short-circuits and surfaces the cap details", async () => {
    const cloud = new InMemoryCloud({
      manifestId: "m6",
      manifestCapReached: { cap: 5, used: 5, windowResetsAt: "2026-06-28T00:00:00.000Z" },
    });
    const result = await uploadSnapshot(baseInput(cloud));
    expect(result).toEqual({
      status: "cap_reached",
      cap: 5,
      used: 5,
      windowResetsAt: "2026-06-28T00:00:00.000Z",
    });
    expect(cloud.presignedSessions).toHaveLength(0);
  });

  it("re-presigns and retries the presign+PUT pair on a transient PUT failure", async () => {
    const cloud = new InMemoryCloud({ manifestId: "m7", failPutWith: 500 });
    // withRetry exhausts its attempts and rethrows; each attempt re-presigns.
    await expect(uploadSnapshot(baseInput(cloud))).rejects.toBeInstanceOf(CloudPortError);
    expect(cloud.presignedSessions.length).toBeGreaterThan(1);
    expect(cloud.puttedBodies.size).toBe(0);
  });

  it("propagates a completeManifest failure (no result swallowing)", async () => {
    const cloud = new InMemoryCloud({ manifestId: "m8", failCompleteWith: 410 });
    await expect(uploadSnapshot(baseInput(cloud))).rejects.toThrow(/HTTP 410/);
    // The body was uploaded before complete failed.
    expect(cloud.puttedBodies.size).toBe(1);
  });
});

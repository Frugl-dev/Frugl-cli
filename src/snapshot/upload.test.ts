import { describe, it, expect } from "vitest";
import { uploadSnapshot, filterPositive } from "./upload.js";
import { InMemoryCloud } from "../upload/in-memory-cloud.js";

function baseInput(cloud: InMemoryCloud, body: Buffer) {
  return {
    cloud,
    cliVersion: "1.2.3",
    sourceKind: "claude-code",
    policyVersion: "v0.2",
    capturedAt: "2026-06-06T09:00:00.000Z",
    artifactKind: "mcp_snapshot" as const,
    formatVersion: "mcp/v1",
    body,
    expectedBytes: body.byteLength,
    redactionsByCategory: { secret: 2, empty: 0 },
  };
}

describe("uploadSnapshot (mcp_snapshot)", () => {
  it("sends an mcp_snapshot manifest with one timestamped entry and JSON body", async () => {
    const cloud = new InMemoryCloud();
    const body = Buffer.from(JSON.stringify({ mcpServers: [{ name: "github" }] }), "utf8");
    const upload = await uploadSnapshot(baseInput(cloud, body));

    const manifest = [...cloud.manifests.values()][0]!;
    expect(manifest.artifact_kind).toBe("mcp_snapshot");
    expect(manifest.expected_session_count).toBe(1);
    expect(manifest.sessions).toHaveLength(1);

    const entry = manifest.sessions[0]!;
    expect(entry.format_version).toBe("mcp/v1");
    expect(entry.captured_at).toBe("2026-06-06T09:00:00.000Z");
    expect(entry.expected_bytes).toBe(body.byteLength);
    expect(entry.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    expect(Buffer.from(cloud.puttedBodies.get(upload.sessionId)!).toString("utf8")).toBe(
      body.toString("utf8"),
    );
  });

  it("rides the project identity onto the manifest entry when provided (spec 051)", async () => {
    const cloud = new InMemoryCloud();
    const body = Buffer.from("{}", "utf8");
    await uploadSnapshot({ ...baseInput(cloud, body), project: "frugl" });

    const entry = [...cloud.manifests.values()][0]!.sessions[0]!;
    expect(entry.project).toBe("frugl");
  });

  it("omits project from the entry when unresolved (back-compat)", async () => {
    const cloud = new InMemoryCloud();
    const body = Buffer.from("{}", "utf8");
    await uploadSnapshot(baseInput(cloud, body));

    const entry = [...cloud.manifests.values()][0]!.sessions[0]!;
    expect(entry.project).toBeUndefined();
  });

  it("filterPositive drops zero/negative counts from the redaction summary", () => {
    expect(filterPositive({ secret: 2, empty: 0, neg: -1 })).toEqual({ secret: 2 });
  });

  it("mints a fresh session id each run (no overwrite semantics)", async () => {
    const cloud = new InMemoryCloud();
    const body = Buffer.from("{}", "utf8");
    const a = await uploadSnapshot(baseInput(cloud, body));
    const b = await uploadSnapshot(baseInput(cloud, body));
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

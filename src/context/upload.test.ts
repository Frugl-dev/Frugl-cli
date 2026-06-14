import { describe, it, expect } from "vitest";
import {
  CONTEXT_FORMAT_VERSION,
  uploadContextSnapshot,
  type ContextUploadResult,
} from "./upload.js";
import { InMemoryCloud } from "../upload/in-memory-cloud.js";
import { anonymize } from "../anonymize/index.js";

const SAMPLE = "## Context Usage\n\n**Tokens:** 21.9k / 1m (2%)\n";

function anonymized(text = SAMPLE, uploadId = "2026-06-06T09:00:00.000Z") {
  return anonymize(text, { uploadId, ownerEmail: "owner@example.com" });
}

// Narrow to the uploaded variant, failing loudly otherwise — keeps the assertion
// unconditional while giving the rest of a test access to the upload fields.
function expectUploaded(
  r: ContextUploadResult,
): Extract<ContextUploadResult, { status: "uploaded" }> {
  if (r.status !== "uploaded") throw new Error(`expected uploaded, got ${r.status}`);
  return r;
}

const baseInput = (
  cloud: InMemoryCloud,
  result: ReturnType<typeof anonymized>,
  capturedAt: string,
) => ({
  cloud,
  cliVersion: "1.2.3",
  sourceKind: "claude-code",
  policyVersion: result.policyVersion,
  capturedAt,
  anonymization: result,
});

describe("uploadContextSnapshot", () => {
  it("sends a context_snapshot manifest with exactly one timestamped, fingerprinted entry", async () => {
    const cloud = new InMemoryCloud();
    const result = anonymized();
    await uploadContextSnapshot(baseInput(cloud, result, "2026-06-06T09:00:00.000Z"));

    const manifest = [...cloud.manifests.values()][0];
    expect(manifest).toBeDefined();
    expect(manifest!.artifact_kind).toBe("context_snapshot");
    expect(manifest!.source_kind).toBe("claude-code");
    expect(manifest!.expected_session_count).toBe(1);
    expect(manifest!.redaction_policy_version).toBe(result.policyVersion);
    expect(manifest!.cli_version).toBe("1.2.3");
    expect(manifest!.sessions).toHaveLength(1);

    const entry = manifest!.sessions[0]!;
    expect(entry.format_version).toBe(CONTEXT_FORMAT_VERSION);
    expect(entry.captured_at).toBe("2026-06-06T09:00:00.000Z");
    expect(entry.expected_bytes).toBe(result.byteSize);
    // The no-change fingerprint rides the entry (spec 052).
    expect(entry.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.content_hash).toBe(result.contentHashHex);
    // Fresh uuid v4 per run.
    expect(entry.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("sends a content_hash stable across run identity but sensitive to content (FR-002)", async () => {
    // Same content, different uploadId AND different captured_at → identical hash.
    const cloudA = new InMemoryCloud();
    await uploadContextSnapshot(
      baseInput(cloudA, anonymized(SAMPLE, "id-A"), "2026-06-06T09:00:00.000Z"),
    );
    const hashA = [...cloudA.manifests.values()][0]!.sessions[0]!.content_hash;

    const cloudB = new InMemoryCloud();
    await uploadContextSnapshot(
      baseInput(cloudB, anonymized(SAMPLE, "id-B"), "2026-06-06T23:30:00.000Z"),
    );
    const hashB = [...cloudB.manifests.values()][0]!.sessions[0]!.content_hash;

    expect(hashB).toBe(hashA);

    // Changed content (token counts moved) → different hash → would upload.
    const cloudC = new InMemoryCloud();
    const changed = "## Context Usage\n\n**Tokens:** 25.1k / 1m (3%)\n";
    await uploadContextSnapshot(
      baseInput(cloudC, anonymized(changed, "id-C"), "2026-06-06T09:00:00.000Z"),
    );
    const hashC = [...cloudC.manifests.values()][0]!.sessions[0]!.content_hash;

    expect(hashC).not.toBe(hashA);
  });

  it("PUTs the anonymized TEXT bytes (UTF-8), not JSON-wrapped", async () => {
    const cloud = new InMemoryCloud();
    const result = anonymized();
    const upload = expectUploaded(
      await uploadContextSnapshot(baseInput(cloud, result, "2026-06-06T09:00:00.000Z")),
    );

    const body = cloud.puttedBodies.get(upload.sessionId);
    expect(body).toBeDefined();
    expect(Buffer.from(body!).toString("utf8")).toBe(String(result.payload));
  });

  it("mints a fresh session id each run (no overwrite semantics)", async () => {
    const cloud = new InMemoryCloud();
    const result = anonymized();
    const a = expectUploaded(
      await uploadContextSnapshot(baseInput(cloud, result, "2026-06-06T09:00:00.000Z")),
    );
    const b = expectUploaded(
      await uploadContextSnapshot(baseInput(cloud, result, "2026-06-06T10:00:00.000Z")),
    );
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("skips the upload when the server reports no_change (spec 052)", async () => {
    const cloud = new InMemoryCloud({ manifestNoChange: true });
    const r = await uploadContextSnapshot(
      baseInput(cloud, anonymized(), "2026-06-06T09:00:00.000Z"),
    );
    expect(r).toEqual({ status: "no_change" });
    // The gate decided before any bytes were sent.
    expect(cloud.presignedSessions).toHaveLength(0);
    expect(cloud.puttedBodies.size).toBe(0);
  });

  it("returns cap_reached and uploads nothing when over the weekly cap (spec 052)", async () => {
    const cloud = new InMemoryCloud({
      manifestCapReached: { cap: 7, used: 7, windowResetsAt: "2026-06-21T00:00:00.000Z" },
    });
    const r = await uploadContextSnapshot(
      baseInput(cloud, anonymized(), "2026-06-06T09:00:00.000Z"),
    );
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

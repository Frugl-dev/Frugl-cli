import { describe, it, expect } from "vitest";
import { CONTEXT_FORMAT_VERSION, uploadContextSnapshot } from "./upload.js";
import { InMemoryCloud } from "../upload/in-memory-cloud.js";
import { anonymize } from "../anonymize/index.js";

const SAMPLE = "## Context Usage\n\n**Tokens:** 21.9k / 1m (2%)\n";

function anonymized(text = SAMPLE) {
  return anonymize(text, { uploadId: "2026-06-06T09:00:00.000Z", ownerEmail: "owner@example.com" });
}

describe("uploadContextSnapshot", () => {
  it("sends a context_snapshot manifest with exactly one timestamped entry", async () => {
    const cloud = new InMemoryCloud();
    const result = anonymized();
    await uploadContextSnapshot({
      cloud,
      cliVersion: "1.2.3",
      sourceKind: "claude-code",
      policyVersion: result.policyVersion,
      capturedAt: "2026-06-06T09:00:00.000Z",
      anonymization: result,
    });

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
    // Fresh uuid v4 per run.
    expect(entry.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("PUTs the anonymized TEXT bytes (UTF-8), not JSON-wrapped", async () => {
    const cloud = new InMemoryCloud();
    const result = anonymized();
    const upload = await uploadContextSnapshot({
      cloud,
      cliVersion: "1.2.3",
      sourceKind: "claude-code",
      policyVersion: result.policyVersion,
      capturedAt: "2026-06-06T09:00:00.000Z",
      anonymization: result,
    });

    const body = cloud.puttedBodies.get(upload.sessionId);
    expect(body).toBeDefined();
    expect(Buffer.from(body!).toString("utf8")).toBe(String(result.payload));
  });

  it("mints a fresh session id each run (no overwrite semantics)", async () => {
    const cloud = new InMemoryCloud();
    const result = anonymized();
    const a = await uploadContextSnapshot({
      cloud,
      cliVersion: "1.2.3",
      sourceKind: "claude-code",
      policyVersion: result.policyVersion,
      capturedAt: "2026-06-06T09:00:00.000Z",
      anonymization: result,
    });
    const b = await uploadContextSnapshot({
      cloud,
      cliVersion: "1.2.3",
      sourceKind: "claude-code",
      policyVersion: result.policyVersion,
      capturedAt: "2026-06-06T10:00:00.000Z",
      anonymization: result,
    });
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

import { describe, expect, it } from "vitest";
import {
  artifactKindSchema,
  createManifestRequestSchema,
  createManifestResponseSchema,
  gitContextRequestSchema,
  handoffRequestSchema,
  manifestEntryRequestSchema,
  orgMeResponseSchema,
  presignResponseSchema,
  sessionMetricsSchema,
  skillScopeEntrySchema,
  skillScopesPayloadSchema,
  versionGateBodySchema,
} from "./schemas.js";

// These tests target the schemas that carry real validation logic (regex,
// refinements, coercion, discriminated unions, passthrough) and that ride the
// wire — not trivial passthrough fields.

describe("gitContextRequestSchema", () => {
  const base = {
    repository: { host: "github.com", owner: "acme", name: "repo" },
    commit_sha: "a".repeat(40),
  };

  it("accepts a 40-char lowercase-hex commit_sha", () => {
    expect(gitContextRequestSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a commit_sha that is not 40 hex chars", () => {
    expect(gitContextRequestSchema.safeParse({ ...base, commit_sha: "abc123" }).success).toBe(
      false,
    );
    // Uppercase hex is outside [0-9a-f].
    expect(gitContextRequestSchema.safeParse({ ...base, commit_sha: "A".repeat(40) }).success).toBe(
      false,
    );
  });

  it("requires a non-empty repository host/owner/name", () => {
    const bad = { ...base, repository: { host: "", owner: "acme", name: "repo" } };
    expect(gitContextRequestSchema.safeParse(bad).success).toBe(false);
  });

  it("treats branch as optional", () => {
    const parsed = gitContextRequestSchema.parse(base);
    expect(parsed.branch).toBeUndefined();
  });
});

describe("sessionMetricsSchema", () => {
  const valid = {
    cost_basis: "cli",
    total_cost_usd: 1.5,
    total_tokens: 100,
    input_tokens: 60,
    output_tokens: 40,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    reasoning_tokens: null,
    turn_count: 3,
    started_at: "2026-01-01T00:00:00Z",
    ended_at: null,
    primary_model: "claude",
    model_provider: "anthropic",
    partial_data: false,
    models: [
      {
        model: "claude",
        input_tokens: 60,
        output_tokens: 40,
        cache_creation_tokens: null,
        cache_read_tokens: null,
        reasoning_tokens: null,
        cost_usd: 1.5,
      },
    ],
  };

  it("accepts a fully-populated metrics block with the literal cost_basis", () => {
    expect(sessionMetricsSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a cost_basis other than the literal 'cli'", () => {
    expect(sessionMetricsSchema.safeParse({ ...valid, cost_basis: "actual" }).success).toBe(false);
  });

  it("rejects negative token counts", () => {
    expect(sessionMetricsSchema.safeParse({ ...valid, total_tokens: -1 }).success).toBe(false);
  });

  it("rejects a non-integer turn_count", () => {
    expect(sessionMetricsSchema.safeParse({ ...valid, turn_count: 1.5 }).success).toBe(false);
  });

  it("requires at least one per-model usage entry", () => {
    expect(sessionMetricsSchema.safeParse({ ...valid, models: [] }).success).toBe(false);
  });

  it("allows nullable numeric fields to be null (unmeasured)", () => {
    const parsed = sessionMetricsSchema.parse({ ...valid, total_cost_usd: null });
    expect(parsed.total_cost_usd).toBeNull();
  });
});

describe("manifestEntryRequestSchema", () => {
  const base = {
    session_id: "s1",
    format_version: "claude-code/v1",
    expected_bytes: 10,
  };

  it("accepts a minimal entry and leaves optional fields undefined", () => {
    const parsed = manifestEntryRequestSchema.parse(base);
    expect(parsed.tier).toBeUndefined();
    expect(parsed.git_context).toBeUndefined();
    expect(parsed.content_hash).toBeUndefined();
  });

  it("rejects an empty session_id and one over 128 chars", () => {
    expect(manifestEntryRequestSchema.safeParse({ ...base, session_id: "" }).success).toBe(false);
    expect(
      manifestEntryRequestSchema.safeParse({ ...base, session_id: "x".repeat(129) }).success,
    ).toBe(false);
  });

  it("rejects a non-integer or negative expected_bytes", () => {
    expect(manifestEntryRequestSchema.safeParse({ ...base, expected_bytes: -1 }).success).toBe(
      false,
    );
    expect(manifestEntryRequestSchema.safeParse({ ...base, expected_bytes: 1.5 }).success).toBe(
      false,
    );
  });

  it("validates content_hash as 64 lowercase-hex chars", () => {
    expect(
      manifestEntryRequestSchema.safeParse({ ...base, content_hash: "f".repeat(64) }).success,
    ).toBe(true);
    expect(
      manifestEntryRequestSchema.safeParse({ ...base, content_hash: "f".repeat(63) }).success,
    ).toBe(false);
    expect(
      manifestEntryRequestSchema.safeParse({ ...base, content_hash: "Z".repeat(64) }).success,
    ).toBe(false);
  });

  it("validates captured_at as an ISO datetime when present", () => {
    expect(
      manifestEntryRequestSchema.safeParse({ ...base, captured_at: "2026-01-01T00:00:00Z" })
        .success,
    ).toBe(true);
    expect(
      manifestEntryRequestSchema.safeParse({ ...base, captured_at: "not-a-date" }).success,
    ).toBe(false);
  });

  it("only accepts the known tier enum values", () => {
    expect(manifestEntryRequestSchema.safeParse({ ...base, tier: "metadata" }).success).toBe(true);
    expect(manifestEntryRequestSchema.safeParse({ ...base, tier: "partial" }).success).toBe(false);
  });
});

describe("artifactKindSchema", () => {
  it("accepts the three known kinds and rejects unknown ones", () => {
    expect(artifactKindSchema.safeParse("session").success).toBe(true);
    expect(artifactKindSchema.safeParse("context_snapshot").success).toBe(true);
    expect(artifactKindSchema.safeParse("mcp_snapshot").success).toBe(true);
    expect(artifactKindSchema.safeParse("other").success).toBe(false);
  });
});

describe("skillScopeEntrySchema", () => {
  it("accepts a project-scoped entry with a project_key", () => {
    const parsed = skillScopeEntrySchema.parse({
      name: "my-skill",
      scope: "project",
      project_key: "proj-123",
    });
    expect(parsed.project_key).toBe("proj-123");
  });

  it("accepts a null project_key (non-project scope)", () => {
    expect(
      skillScopeEntrySchema.safeParse({ name: "s", scope: "user", project_key: null }).success,
    ).toBe(true);
  });

  it("rejects an unknown scope", () => {
    expect(
      skillScopeEntrySchema.safeParse({ name: "s", scope: "global", project_key: null }).success,
    ).toBe(false);
  });
});

describe("skillScopesPayloadSchema", () => {
  const valid = {
    schema: "frugl.skill-scopes",
    schema_version: 1,
    captured_at: "2026-01-01T00:00:00Z",
    provider: "claude_code",
    skills: [{ name: "s", scope: "user", project_key: null }],
  };

  it("accepts a well-formed payload", () => {
    expect(skillScopesPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it("pins the schema/version/provider literals", () => {
    expect(skillScopesPayloadSchema.safeParse({ ...valid, schema_version: 2 }).success).toBe(false);
    expect(skillScopesPayloadSchema.safeParse({ ...valid, provider: "claude-code" }).success).toBe(
      false,
    );
    expect(skillScopesPayloadSchema.safeParse({ ...valid, schema: "other" }).success).toBe(false);
  });

  it("caps the skills array at 500", () => {
    const skills = Array.from({ length: 501 }, () => ({
      name: "s",
      scope: "user" as const,
      project_key: null,
    }));
    expect(skillScopesPayloadSchema.safeParse({ ...valid, skills }).success).toBe(false);
  });
});

describe("createManifestRequestSchema", () => {
  const valid = {
    cli_version: "0.1.4",
    redaction_policy_version: "v0.2",
    source_kind: "claude-code",
    expected_session_count: 1,
    sessions: [{ session_id: "s1", format_version: "claude-code/v1", expected_bytes: 10 }],
  };

  it("accepts a minimal valid request", () => {
    expect(createManifestRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("requires expected_session_count >= 1 and at least one session", () => {
    expect(
      createManifestRequestSchema.safeParse({ ...valid, expected_session_count: 0 }).success,
    ).toBe(false);
    expect(createManifestRequestSchema.safeParse({ ...valid, sessions: [] }).success).toBe(false);
  });

  it("rejects an empty redaction_policy_version or source_kind", () => {
    expect(
      createManifestRequestSchema.safeParse({ ...valid, redaction_policy_version: "" }).success,
    ).toBe(false);
    expect(createManifestRequestSchema.safeParse({ ...valid, source_kind: "" }).success).toBe(
      false,
    );
  });

  it("caps mcp_servers at 100", () => {
    const mcp_servers = Array.from({ length: 101 }, () => ({ name: "x", status: "connected" }));
    expect(createManifestRequestSchema.safeParse({ ...valid, mcp_servers }).success).toBe(false);
  });

  it("validates a nested artifact_kind enum", () => {
    expect(
      createManifestRequestSchema.safeParse({ ...valid, artifact_kind: "context_snapshot" })
        .success,
    ).toBe(true);
    expect(
      createManifestRequestSchema.safeParse({ ...valid, artifact_kind: "bogus" }).success,
    ).toBe(false);
  });
});

describe("createManifestResponseSchema (union)", () => {
  it("parses a created-upload response", () => {
    const parsed = createManifestResponseSchema.parse({ upload_id: "u1" });
    expect(parsed).toMatchObject({ upload_id: "u1" });
  });

  it("parses a no-change skip response", () => {
    const parsed = createManifestResponseSchema.parse({
      status: "no_change",
      artifact_kind: "context_snapshot",
    });
    expect(parsed).toMatchObject({ status: "no_change", artifact_kind: "context_snapshot" });
  });

  it("rejects a payload matching neither variant", () => {
    expect(createManifestResponseSchema.safeParse({ unexpected: true }).success).toBe(false);
  });
});

describe("presignResponseSchema", () => {
  const valid = {
    presigned_url: "https://s3.example.com/obj?sig=1",
    method: "PUT",
    headers: { "content-type": "application/json" },
    expires_at: "2026-01-01T00:00:00Z",
  };

  it("accepts a valid presign response", () => {
    expect(presignResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a non-URL presigned_url", () => {
    expect(presignResponseSchema.safeParse({ ...valid, presigned_url: "not a url" }).success).toBe(
      false,
    );
  });

  it("pins the method to the PUT literal", () => {
    expect(presignResponseSchema.safeParse({ ...valid, method: "POST" }).success).toBe(false);
  });

  it("rejects an http presigned_url on a non-loopback host — the payload must never travel plaintext", () => {
    expect(
      presignResponseSchema.safeParse({ ...valid, presigned_url: "http://s3.example.com/obj" })
        .success,
    ).toBe(false);
  });

  it("accepts an http presigned_url on loopback (local dev stack)", () => {
    for (const url of ["http://127.0.0.1:4001/put", "http://localhost:4001/put"]) {
      expect(presignResponseSchema.safeParse({ ...valid, presigned_url: url }).success).toBe(true);
    }
  });
});

describe("handoffRequestSchema (open-redirect refinement)", () => {
  it("accepts a relative path", () => {
    expect(handoffRequestSchema.safeParse({ redirect_to: "/dashboard" }).success).toBe(true);
  });

  it("rejects a protocol-relative path (//evil.com)", () => {
    expect(handoffRequestSchema.safeParse({ redirect_to: "//evil.com" }).success).toBe(false);
  });

  it("rejects an absolute URL with a scheme", () => {
    expect(handoffRequestSchema.safeParse({ redirect_to: "https://evil.com" }).success).toBe(false);
  });

  it("rejects a path not starting with a slash", () => {
    expect(handoffRequestSchema.safeParse({ redirect_to: "dashboard" }).success).toBe(false);
  });
});

describe("versionGateBodySchema (refinement on either key)", () => {
  it("accepts the snake_case min_version", () => {
    expect(versionGateBodySchema.safeParse({ min_version: "2.0.0" }).success).toBe(true);
  });

  it("accepts the legacy camelCase minSupportedCliVersion", () => {
    expect(versionGateBodySchema.safeParse({ minSupportedCliVersion: "2.0.0" }).success).toBe(true);
  });

  it("rejects a body carrying neither key", () => {
    expect(versionGateBodySchema.safeParse({ other: "x" }).success).toBe(false);
  });
});

describe("orgMeResponseSchema (passthrough)", () => {
  it("parses required fields and preserves unknown ones via passthrough", () => {
    const parsed = orgMeResponseSchema.parse({
      org: { id: "o1", name: "Acme", slug: "acme", extra_org_field: true },
      membership: { role: "admin", extra_member_field: 1 },
      top_level_extra: "kept",
    });
    expect(parsed.org.slug).toBe("acme");
    // passthrough keeps unknown keys.
    expect((parsed as Record<string, unknown>)["top_level_extra"]).toBe("kept");
    expect((parsed.org as Record<string, unknown>)["extra_org_field"]).toBe(true);
  });

  it("rejects a missing membership.role", () => {
    expect(
      orgMeResponseSchema.safeParse({ org: { id: "o1", name: "Acme", slug: "acme" } }).success,
    ).toBe(false);
  });
});

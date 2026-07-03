import { z } from "zod";

export const otpRequestResponseSchema = z.object({
  ok: z.literal(true),
});
export type OtpRequestResponse = z.infer<typeof otpRequestResponseSchema>;

export const otpVerifyResponseSchema = z.object({
  user_id: z.string().min(1),
  session: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_at: z.string().min(1),
  }),
});
export type OtpVerifyResponse = z.infer<typeof otpVerifyResponseSchema>;

export const logoutResponseSchema = z.object({
  ok: z.literal(true),
});
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

export const whoamiResponseSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  loggedInAt: z.string().datetime(),
});
export type WhoamiResponse = z.infer<typeof whoamiResponseSchema>;

// GET /api/auth/whoami wire shape — used to resolve identity for a headless
// access token (and for the synthetic org service identity).
export const identityResponseSchema = z.object({
  user_id: z.string().min(1),
  primary_email: z.string().email(),
  providers: z.array(z.string()).optional(),
});
export type IdentityResponse = z.infer<typeof identityResponseSchema>;

// Opt-in (005) git coordinate, snake_case wire shape. Strictly additive.
export const gitContextRequestSchema = z.object({
  repository: z.object({
    host: z.string().min(1),
    owner: z.string().min(1),
    name: z.string().min(1),
  }),
  branch: z.string().min(1).optional(),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type GitContextRequest = z.infer<typeof gitContextRequestSchema>;

// The artifact a manifest carries. "session" is the historical default (parsed
// session logs); "context_snapshot" (spec 025) is a single timestamped capture
// of a tool's /context breakdown; "mcp_snapshot" (spec 026) is a single
// timestamped capture of the declared MCP server inventory. The field is
// optional + defaults to "session" so existing session uploads stay
// byte-identical on the wire.
export const artifactKindSchema = z.enum(["session", "context_snapshot", "mcp_snapshot"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

// Per-model usage for a metadata-only session (spec 054), mirroring the cloud's
// session_model_usage columns. Numbers are non-negative; null = unmeasured.
export const sessionModelUsageMetricSchema = z.object({
  model: z.string().min(1).max(200),
  input_tokens: z.number().min(0).nullable(),
  output_tokens: z.number().min(0).nullable(),
  cache_creation_tokens: z.number().min(0).nullable(),
  cache_read_tokens: z.number().min(0).nullable(),
  reasoning_tokens: z.number().min(0).nullable(),
  cost_usd: z.number().min(0).nullable(),
});

// The compact metrics block carried by a metadata-only session (spec 054):
// there is no raw object, so the cost/token/per-model numbers ride the manifest.
// Mirrors the cloud's parseSessionMetrics contract; cost_basis is always "cli".
export const sessionMetricsSchema = z.object({
  cost_basis: z.literal("cli"),
  total_cost_usd: z.number().min(0).nullable(),
  total_tokens: z.number().min(0).nullable(),
  input_tokens: z.number().min(0).nullable(),
  output_tokens: z.number().min(0).nullable(),
  cache_creation_tokens: z.number().min(0).nullable(),
  cache_read_tokens: z.number().min(0).nullable(),
  reasoning_tokens: z.number().min(0).nullable(),
  turn_count: z.number().int().min(0),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  primary_model: z.string().nullable(),
  model_provider: z.string().nullable(),
  partial_data: z.boolean(),
  models: z.array(sessionModelUsageMetricSchema).min(1),
});
export type SessionMetricsRequest = z.infer<typeof sessionMetricsSchema>;

// Upload tier (spec 054). "full" (default) uploads the raw transcript; "metadata"
// sends only `metrics`. Optional + additive — an older CLI omits it (⇒ full).
export const sessionTierSchema = z.enum(["full", "metadata"]);
export type SessionTierWire = z.infer<typeof sessionTierSchema>;

export const manifestEntryRequestSchema = z.object({
  session_id: z.string().min(1).max(128),
  format_version: z.string().min(1),
  expected_bytes: z.number().int().min(0),
  git_context: gitContextRequestSchema.optional(),
  // spec 054 — tier + metrics. metadata entries carry metrics and no raw body.
  tier: sessionTierSchema.optional(),
  metrics: sessionMetricsSchema.optional(),
  // Sub-path within .claude/worktrees/ when the session comes from a worktree.
  worktree_path: z.string().min(1).optional(),
  // Capture timestamp (ISO 8601). Optional on the wire for back-compat, but the
  // server requires it when artifact_kind === "context_snapshot".
  captured_at: z.string().datetime().optional(),
  // No-change fingerprint (spec 052): a sha256 hex of the capture content,
  // independent of the per-run uploadId and captured_at. The server compares it
  // to the user's latest snapshot of the same kind+project and skips the upload
  // on an exact match. Optional + additive — omitting it just skips the check.
  content_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type ManifestEntryRequest = z.infer<typeof manifestEntryRequestSchema>;

// Declared MCP server inventory (names-only slice of spec 026): name + health
// status from `claude mcp list`, captured at manifest time. Optional — a CLI
// that couldn't run the capture omits the field rather than blocking the
// upload. Statuses mirror the capture vocabulary (capture/types.ts McpStatus).
export const declaredMcpServerSchema = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(["connected", "failed", "pending", "unknown"]),
});
export type WireDeclaredMcpServer = z.infer<typeof declaredMcpServerSchema>;

// Skill-scope map (spec 047 Phase 8): the on-disk scope of each skill LOADED in
// a context snapshot, which the raw /context text alone can't express to the
// cloud's typed store. Carries NO content/scores — only name → scope so ingest
// can stamp scope onto the snapshot's skill items. `provider` is the underscored
// canonical key ("claude_code"), distinct from the dashed source_kind. Mirrors
// the cloud's frugl.skill-scopes contract (packages/schema/src/skill-scopes.ts);
// the server re-validates at the manifest trust boundary and again at ingest.
export const skillScopeEntrySchema = z.object({
  name: z.string().min(1).max(200),
  scope: z.enum(["user", "project", "plugin"]),
  // Anonymized project identity, present ONLY for project scope; null otherwise.
  project_key: z.string().max(200).nullable(),
});
export type WireSkillScopeEntry = z.infer<typeof skillScopeEntrySchema>;

export const skillScopesPayloadSchema = z.object({
  schema: z.literal("frugl.skill-scopes"),
  schema_version: z.literal(1),
  captured_at: z.string().min(1),
  provider: z.literal("claude_code"),
  skills: z.array(skillScopeEntrySchema).max(500),
});
export type WireSkillScopesPayload = z.infer<typeof skillScopesPayloadSchema>;

export const createManifestRequestSchema = z.object({
  cli_version: z.string(),
  redaction_policy_version: z.string().min(1),
  source_kind: z.string().min(1),
  expected_session_count: z.number().int().min(1),
  sessions: z.array(manifestEntryRequestSchema).min(1),
  // Optional; defaults to "session" server-side. Sent explicitly only for
  // context snapshots so older flows are untouched.
  artifact_kind: artifactKindSchema.optional(),
  mcp_servers: z.array(declaredMcpServerSchema).max(100).optional(),
  // Skill scopes ride the context snapshot manifest (the mcp_servers precedent);
  // omitted when the capture has no scope-bearing skills.
  skill_scopes: skillScopesPayloadSchema.optional(),
});
export type CreateManifestRequest = z.infer<typeof createManifestRequestSchema>;

// A created upload — the historical happy path.
export const manifestCreatedResponseSchema = z.object({
  upload_id: z.string().min(1),
  session_object_ids: z.array(z.string()).optional(),
});

// Snapshot no-change skip (spec 052): the server found the content identical to
// the user's latest snapshot of this kind+project and wrote nothing. Returned
// 200 (an OK status), so it must be an accepted response shape, not an error.
export const manifestNoChangeResponseSchema = z.object({
  status: z.literal("no_change"),
  artifact_kind: z.string().min(1),
});

// A 200 manifest response is either a created upload or a no-change skip.
export const createManifestResponseSchema = z.union([
  manifestCreatedResponseSchema,
  manifestNoChangeResponseSchema,
]);
export type CreateManifestResponse = z.infer<typeof createManifestResponseSchema>;

// The presigned URL receives the anonymized payload, so it must never point at
// a plaintext host — same rule as validateEndpoint (endpoints.ts): https only,
// with http allowed on loopback for local dev stacks.
function isHttpsOrLoopback(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]")
  );
}

export const presignResponseSchema = z.object({
  presigned_url: z
    .string()
    .url()
    .refine(isHttpsOrLoopback, "presigned_url must use https (or http on localhost)"),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expires_at: z.string().min(1),
});
export type PresignResponse = z.infer<typeof presignResponseSchema>;

export const completeUploadRequestSchema = z.object({
  redaction_summary: z.record(z.string(), z.number().int().min(0)),
});
export type CompleteUploadRequest = z.infer<typeof completeUploadRequestSchema>;

export const completeUploadResponseSchema = z.object({
  manifest_id: z.string().min(1),
  dashboard_url: z.string().min(1),
});
export type CompleteUploadResponse = z.infer<typeof completeUploadResponseSchema>;

// CLI→web session handoff (006). `redirect_to` is the open-redirect guard: a
// relative path only — both sides of the wire enforce it (contracts/handoff-api.md).
export const handoffRequestSchema = z.object({
  redirect_to: z
    .string()
    .min(1)
    .refine((p) => p.startsWith("/") && !p.startsWith("//") && !p.includes("://"), {
      message: "redirect_to must be a relative path",
    }),
});
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;

export const handoffResponseSchema = z.object({
  code: z.string().min(1),
  expires_at: z.string().min(1),
});
export type HandoffResponse = z.infer<typeof handoffResponseSchema>;

// The server's 426 body uses snake_case `min_version` (see the cloud repo's
// contracts/uploads.md); older drafts used `minSupportedCliVersion`. Accept
// either so the gate message can always name the required version.
export const versionGateBodySchema = z
  .object({
    minSupportedCliVersion: z.string().optional(),
    min_version: z.string().optional(),
  })
  .refine((body) => body.minSupportedCliVersion !== undefined || body.min_version !== undefined, {
    message: "expected minSupportedCliVersion or min_version",
  });
export type VersionGateBody = z.infer<typeof versionGateBodySchema>;

export const orgMeResponseSchema = z
  .object({
    org: z
      .object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        member_count: z.number().int().optional(),
      })
      .passthrough(),
    membership: z.object({ role: z.string() }).passthrough(),
  })
  .passthrough();
export type OrgMeResponse = z.infer<typeof orgMeResponseSchema>;

export const orgCreateResponseSchema = z
  .object({ org: z.object({ id: z.string(), name: z.string(), slug: z.string() }).passthrough() })
  .passthrough();
export type OrgCreateResponse = z.infer<typeof orgCreateResponseSchema>;

export const joinResponseSchema = z
  .object({ org: z.object({ name: z.string(), slug: z.string() }).passthrough() })
  .passthrough();
export type JoinResponse = z.infer<typeof joinResponseSchema>;

// Cost-saving recommendations (frugl/ spec 023). The CLI lists + ranks them and
// can emit a fix prompt or mark one applied/dismissed.
export const recommendationImpactSchema = z
  .object({
    baseline_cost_usd: z.number(),
    baseline_window_days: z.number(),
    actual_cost_usd: z.number().nullable(),
    projected_baseline_cost_usd: z.number().nullable(),
    realized_savings_usd: z.number().nullable(),
    measurement_status: z.enum(["measuring", "available"]),
  })
  .passthrough();

export const recommendationSchema = z
  .object({
    id: z.string().min(1),
    rule_key: z.string(),
    target_key: z.string(),
    category: z.string(),
    title: z.string(),
    description: z.string(),
    estimated_savings_usd: z.number(),
    fix_prompt: z.string(),
    automatable: z.boolean(),
    status: z.enum(["open", "applied", "dismissed", "resolved"]),
    applied_at: z.string().nullable(),
    impact: recommendationImpactSchema.nullable(),
  })
  .passthrough();
export type RecommendationItem = z.infer<typeof recommendationSchema>;

export const recommendationsListResponseSchema = z.object({
  recommendations: z.array(recommendationSchema),
});
export type RecommendationsListResponse = z.infer<typeof recommendationsListResponseSchema>;

export const recommendationApplyResponseSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    applied_at: z.string().nullable(),
  })
  .passthrough();

export const recommendationDismissResponseSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    dismissed_until: z.string(),
  })
  .passthrough();

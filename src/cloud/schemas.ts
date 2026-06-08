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
// of a tool's /context breakdown. The field is optional + defaults to "session"
// so existing session uploads stay byte-identical on the wire.
export const artifactKindSchema = z.enum(["session", "context_snapshot"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const manifestEntryRequestSchema = z.object({
  session_id: z.string().min(1).max(128),
  format_version: z.string().min(1),
  expected_bytes: z.number().int().min(0),
  git_context: gitContextRequestSchema.optional(),
  // Sub-path within .claude/worktrees/ when the session comes from a worktree.
  worktree_path: z.string().min(1).optional(),
  // Capture timestamp (ISO 8601). Optional on the wire for back-compat, but the
  // server requires it when artifact_kind === "context_snapshot".
  captured_at: z.string().datetime().optional(),
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
});
export type CreateManifestRequest = z.infer<typeof createManifestRequestSchema>;

export const createManifestResponseSchema = z.object({
  upload_id: z.string().min(1),
  session_object_ids: z.array(z.string()).optional(),
});
export type CreateManifestResponse = z.infer<typeof createManifestResponseSchema>;

export const presignResponseSchema = z.object({
  presigned_url: z.string().url(),
  method: z.literal("PUT"),
  headers: z.record(z.string()),
  expires_at: z.string().min(1),
});
export type PresignResponse = z.infer<typeof presignResponseSchema>;

export const completeUploadRequestSchema = z.object({
  redaction_summary: z.record(z.number().int().min(0)),
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
    .refine(
      (p) => {
        if (!p.startsWith("/") || p.includes("://")) return false;
        try {
          return new URL(p, "https://placeholder.invalid").origin === "https://placeholder.invalid";
        } catch {
          return false;
        }
      },
      { message: "redirect_to must be a relative path" },
    ),
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

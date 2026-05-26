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

export const manifestEntryRequestSchema = z.object({
  session_id: z.string().min(1).max(128),
  format_version: z.string().min(1),
  expected_bytes: z.number().int().min(0),
  git_context: gitContextRequestSchema.optional(),
  // Sub-path within .claude/worktrees/ when the session comes from a worktree.
  worktree_path: z.string().min(1).optional(),
});
export type ManifestEntryRequest = z.infer<typeof manifestEntryRequestSchema>;

export const createManifestRequestSchema = z.object({
  cli_version: z.string(),
  redaction_policy_version: z.string().min(1),
  source_kind: z.string().min(1),
  expected_session_count: z.number().int().min(1),
  sessions: z.array(manifestEntryRequestSchema).min(1),
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

export const versionGateBodySchema = z.object({
  minSupportedCliVersion: z.string(),
});
export type VersionGateBody = z.infer<typeof versionGateBodySchema>;

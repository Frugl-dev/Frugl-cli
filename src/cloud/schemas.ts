import { z } from "zod";

export const otpRequestResponseSchema = z.object({
  ok: z.literal(true),
});
export type OtpRequestResponse = z.infer<typeof otpRequestResponseSchema>;

export const otpVerifyResponseSchema = z.object({
  ok: z.literal(true),
  userId: z.string().min(1),
  email: z.string().email(),
  token: z.string().min(1),
  tokenIssuedAt: z.string().datetime(),
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

export const manifestEntryRequestSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/),
  identityDerivation: z.enum(["native", "path-hash"]),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().min(0),
});
export type ManifestEntryRequest = z.infer<typeof manifestEntryRequestSchema>;

export const createManifestRequestSchema = z.object({
  cliVersion: z.string(),
  redactionPolicyVersion: z.string().regex(/^v[0-9]+\.[0-9]+$/),
  sourceKind: z.string().min(1),
  expectedSessionCount: z.number().int().min(1),
  sessions: z.array(manifestEntryRequestSchema).min(1),
});
export type CreateManifestRequest = z.infer<typeof createManifestRequestSchema>;

export const createManifestResponseSchema = z.object({
  manifestId: z.string().min(1),
});
export type CreateManifestResponse = z.infer<typeof createManifestResponseSchema>;

export const presignResponseSchema = z.object({
  url: z.string().url(),
  method: z.literal("PUT"),
  headers: z.record(z.string()),
  expiresAt: z.string().datetime(),
});
export type PresignResponse = z.infer<typeof presignResponseSchema>;

export const completeUploadRequestSchema = z.object({
  actualSessionCount: z.number().int().min(0),
  ackedSessionIds: z.array(z.string()),
});
export type CompleteUploadRequest = z.infer<typeof completeUploadRequestSchema>;

export const completeUploadResponseSchema = z.object({
  manifestId: z.string().min(1),
  dashboardUrl: z.string().url(),
});
export type CompleteUploadResponse = z.infer<typeof completeUploadResponseSchema>;

export const versionGateBodySchema = z.object({
  minSupportedCliVersion: z.string(),
});
export type VersionGateBody = z.infer<typeof versionGateBodySchema>;

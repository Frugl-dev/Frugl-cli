import { CloudClient, CloudHttpError } from "../cloud/client.js";
import {
  createManifestResponseSchema,
  presignResponseSchema,
  completeUploadResponseSchema,
  type CreateManifestRequest,
} from "../cloud/schemas.js";
import { FruglError, NetworkError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { CloudPortError, type PresignResult, type UploadCloudPort } from "./cloud-port.js";

// Production adapter: wraps the existing `CloudClient` and owns everything that
// used to be inline in `pipeline.ts` — the typed control-plane `call()`s, the
// `withRetry` wrapper around presign + PUT, building an error from a non-ok PUT,
// the `org_required` 409 translation, and mapping `CloudHttpError`/`NetworkError`
// onto the transport-agnostic `CloudPortError` the deep module reasons about.
export class HttpCloudAdapter implements UploadCloudPort {
  constructor(private readonly client: CloudClient) {}

  async createManifest(req: CreateManifestRequest): Promise<{ uploadId: string }> {
    let created;
    try {
      created = await this.client.call({
        method: "POST",
        path: "/api/uploads/manifest",
        body: req,
        schema: createManifestResponseSchema,
        timeoutMs: 12_000,
      });
    } catch (err) {
      // A brand-new account with no org gets a 409 { error: "org_required" }.
      // Surface the actionable setup guidance here so the message stays exactly
      // as it was when this lived in the pipeline.
      if (
        err instanceof CloudHttpError &&
        err.status === 409 &&
        typeof err.body === "object" &&
        err.body !== null &&
        (err.body as Record<string, unknown>).error === "org_required"
      ) {
        throw new FruglError(
          "Your account has no organization. Run 'frugl setup' to finish setup.",
          EXIT.GENERIC_FAILURE,
        );
      }
      throw toCloudPortError(err);
    }
    return { uploadId: created.upload_id };
  }

  async presign(manifestId: string, sessionId: string): Promise<PresignResult> {
    let presigned;
    try {
      presigned = await this.client.call({
        method: "POST",
        path: `/api/uploads/${encodeURIComponent(manifestId)}/presign`,
        body: { session_id: sessionId },
        schema: presignResponseSchema,
      });
    } catch (err) {
      throw toCloudPortError(err);
    }
    return { url: presigned.presigned_url, headers: { ...presigned.headers } };
  }

  async putSessionBody(
    url: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ): Promise<void> {
    const response = await this.client.putBody(url, body, headers);
    if (!response.ok) {
      const status = response.status;
      throw new CloudPortError(`PUT presigned URL failed: HTTP ${status}`, {
        status,
        body: await response.text().catch(() => ""),
      });
    }
  }

  async completeManifest(
    manifestId: string,
    redactionSummary: Record<string, number>,
  ): Promise<{ manifestId: string; dashboardUrl: string }> {
    let complete;
    try {
      complete = await this.client.call({
        method: "POST",
        path: `/api/uploads/${encodeURIComponent(manifestId)}/complete`,
        body: { redaction_summary: redactionSummary },
        schema: completeUploadResponseSchema,
      });
    } catch (err) {
      throw toCloudPortError(err);
    }
    return { manifestId: complete.manifest_id, dashboardUrl: complete.dashboard_url };
  }
}

// Map any wire error onto a `CloudPortError`, preserving the HTTP status so the
// classifier (409 → conflict, 403 → presign-expired, 5xx → network) and the
// 404/410 → stale interpretation in `SessionUpload` still see it. Anything that
// is already transport-agnostic (e.g. a `SyntaxError`/`AnonymizationError` from
// payload serialization, or a `CloudPortError` from a nested PUT) passes through.
function toCloudPortError(err: unknown): unknown {
  if (err instanceof CloudPortError) return err;
  if (err instanceof CloudHttpError) {
    return new CloudPortError(err.message, { status: err.status, body: err.body, cause: err });
  }
  if (err instanceof NetworkError) {
    return new CloudPortError(err.message, { cause: err });
  }
  return err;
}

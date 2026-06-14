import type { CreateManifestRequest } from "../cloud/schemas.js";

// The narrow port the per-session upload lifecycle depends on. It exposes
// exactly the four operations `SessionUpload` and the batch orchestrator need —
// nothing about HTTP, fetch, snake_case wire payloads, or the cloud Zod schemas
// leaks across this boundary. Adapters (HTTP for prod, in-memory for tests)
// implement it; the deep module never imports from `../cloud/*`.
// The outcome of POSTing a manifest. A session upload only ever sees `created`;
// snapshot uploads (spec 052) can also be skipped (`no_change`) or refused
// (`cap_reached`) by the server's gate before any bytes are sent.
export type CreateManifestResult =
  | { kind: "created"; uploadId: string }
  | { kind: "no_change" }
  | { kind: "cap_reached"; cap: number; used: number; windowResetsAt: string };

export interface UploadCloudPort {
  createManifest(req: CreateManifestRequest): Promise<CreateManifestResult>;
  presign(manifestId: string, sessionId: string): Promise<PresignResult>;
  putSessionBody(url: string, body: Uint8Array, headers: Record<string, string>): Promise<void>;
  completeManifest(
    manifestId: string,
    redactionSummary: Record<string, number>,
  ): Promise<{ manifestId: string; dashboardUrl: string }>;
}

export interface PresignResult {
  url: string;
  headers: Record<string, string>;
}

// Transport-agnostic error thrown by adapters so the classifier and the
// 404/410 → stale interpretation stay independent of `CloudHttpError`/`fetch`.
// `status` is the primary classification signal (`extractStatus` reads it).
export class CloudPortError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, options: { status?: number; body?: unknown; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CloudPortError";
    if (options.status !== undefined) this.status = options.status;
    if (options.body !== undefined) this.body = options.body;
  }
}

import type { CreateManifestRequest } from "../cloud/schemas.js";
import { CloudPortError, type PresignResult, type UploadCloudPort } from "./cloud-port.js";

// In-memory `UploadCloudPort` for tests. Fakes the *port* surface — not the HTTP
// wire — so it stays valid as the wire contract evolves. Failure knobs drive
// every outcome branch without a real endpoint:
//   - `failPresign`     : session ids whose presign throws `presignError`
//   - `failPutWith`     : status thrown by every PUT (e.g. 500 → network, 403 → presign-expired)
//   - `failCompleteWith`: status thrown by completeManifest (e.g. 410 → stale)
// `presignError`/`putError`/`presignThrow` let a test inject a non-HTTP error
// (SyntaxError, AnonymizationError) to exercise the classifier end-to-end.
export interface InMemoryCloudOptions {
  manifestId?: string;
  failPresign?: Set<string>;
  failPresignWith?: number;
  presignThrow?: (sessionId: string) => unknown;
  failPutWith?: number;
  failCompleteWith?: number;
}

export class InMemoryCloud implements UploadCloudPort {
  readonly manifests = new Map<string, CreateManifestRequest>();
  readonly presignedSessions: string[] = [];
  readonly puttedBodies = new Map<string, Uint8Array>();
  private readonly manifestId: string;

  constructor(private readonly opts: InMemoryCloudOptions = {}) {
    this.manifestId = opts.manifestId ?? "mfst_test";
  }

  async createManifest(req: CreateManifestRequest): Promise<{ uploadId: string }> {
    this.manifests.set(this.manifestId, req);
    return { uploadId: this.manifestId };
  }

  async presign(_manifestId: string, sessionId: string): Promise<PresignResult> {
    this.presignedSessions.push(sessionId);
    if (this.opts.presignThrow) {
      const thrown = this.opts.presignThrow(sessionId);
      if (thrown !== undefined) throw thrown;
    }
    if (this.opts.failPresign?.has(sessionId)) {
      throw new CloudPortError(`forced presign failure for ${sessionId}`, {
        status: this.opts.failPresignWith ?? 500,
      });
    }
    return {
      url: `https://put/${encodeURIComponent(sessionId)}`,
      headers: { "Content-Type": "application/x-ndjson" },
    };
  }

  async putSessionBody(
    url: string,
    body: Uint8Array,
    _headers: Record<string, string>,
  ): Promise<void> {
    if (this.opts.failPutWith !== undefined) {
      throw new CloudPortError(`PUT presigned URL failed: HTTP ${this.opts.failPutWith}`, {
        status: this.opts.failPutWith,
      });
    }
    const sessionId = decodeURIComponent(url.replace(/^https:\/\/put\//, ""));
    this.puttedBodies.set(sessionId, body);
  }

  async completeManifest(
    manifestId: string,
    _redactionSummary: Record<string, number>,
  ): Promise<{ manifestId: string; dashboardUrl: string }> {
    if (this.opts.failCompleteWith !== undefined) {
      throw new CloudPortError(`complete failed: HTTP ${this.opts.failCompleteWith}`, {
        status: this.opts.failCompleteWith,
      });
    }
    return { manifestId, dashboardUrl: `/dashboard?upload=${manifestId}` };
  }
}

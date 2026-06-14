import type { CreateManifestRequest } from "../cloud/schemas.js";
import { AuthError, VersionGateError } from "../lib/errors.js";
import {
  CloudPortError,
  type CreateManifestResult,
  type PresignResult,
  type UploadCloudPort,
} from "./cloud-port.js";

// Mirror the production control-plane mapping (CloudClient.handleResponse):
// 401/403 surface as AuthError and 426 as VersionGateError BEFORE any
// CloudPortError wrapping. A fake that throws status-carrying CloudPortErrors
// for these would let tests pass on behavior production can never exhibit.
function controlPlaneError(status: number, message: string): unknown {
  if (status === 401 || status === 403) {
    return new AuthError(`Authentication failed (${status}). ${message}`, status);
  }
  if (status === 426) return new VersionGateError("0.0.0-test", "test");
  return new CloudPortError(message, { status });
}

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
  // Snapshot gate outcomes (spec 052): force the manifest to skip (no_change) or
  // refuse (cap_reached) instead of creating an upload. Default → created.
  manifestNoChange?: boolean;
  manifestCapReached?: { cap: number; used: number; windowResetsAt: string };
}

export class InMemoryCloud implements UploadCloudPort {
  readonly manifests = new Map<string, CreateManifestRequest>();
  readonly presignedSessions: string[] = [];
  readonly puttedBodies = new Map<string, Uint8Array>();
  private readonly manifestId: string;

  constructor(private readonly opts: InMemoryCloudOptions = {}) {
    this.manifestId = opts.manifestId ?? "mfst_test";
  }

  async createManifest(req: CreateManifestRequest): Promise<CreateManifestResult> {
    this.manifests.set(this.manifestId, req);
    if (this.opts.manifestNoChange) return { kind: "no_change" };
    if (this.opts.manifestCapReached)
      return { kind: "cap_reached", ...this.opts.manifestCapReached };
    return { kind: "created", uploadId: this.manifestId };
  }

  async presign(_manifestId: string, sessionId: string): Promise<PresignResult> {
    this.presignedSessions.push(sessionId);
    if (this.opts.presignThrow) {
      const thrown = this.opts.presignThrow(sessionId);
      if (thrown !== undefined) throw thrown;
    }
    if (this.opts.failPresign?.has(sessionId)) {
      throw controlPlaneError(
        this.opts.failPresignWith ?? 500,
        `forced presign failure for ${sessionId}`,
      );
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
      throw controlPlaneError(
        this.opts.failCompleteWith,
        `complete failed: HTTP ${this.opts.failCompleteWith}`,
      );
    }
    return { manifestId, dashboardUrl: `/dashboard?upload=${manifestId}` };
  }
}

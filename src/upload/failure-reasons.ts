import { AnonymizationError, NetworkError } from "../lib/errors.js";
import { extractStatus } from "../lib/retry.js";

// A presigned storage URL was rejected (expired / clock skew). Deliberately
// carries NO `status` property: the original PUT 403 must not look like a
// control-plane auth failure to `shouldRetry`, because the remedy is to
// re-presign and retry the pair, not to abort.
export class PresignExpiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PresignExpiredError";
  }
}

// The fine-grained, human-readable reason a single session failed to upload.
// One bad session never blocks the others (see pipeline.ts); each failure is
// bucketed here so `frugl upload --report` can explain the cause and the fix.
//
// `skipped` is intentionally NOT a failure reason — a skipped session (its file
// went missing or changed mid-upload) is picked up automatically next run. It
// lives in the resume store under `skippedReason`, not here.
export const FAILURE_REASONS = [
  "parse",
  "conflict",
  "presign-expired",
  "network",
  "anonymization",
  "unknown",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface FailureReasonInfo {
  reason: FailureReason;
  // One-line cause shown next to the reason in the report header.
  summary: string;
  // The remedy line ("→ …"). `{id}` is replaced with the short session id.
  remedy: string;
  // Sort order in the report — most-actionable / most-local first.
  order: number;
}

export const FAILURE_REASON_INFO: Record<FailureReason, FailureReasonInfo> = {
  parse: {
    reason: "parse",
    summary: "malformed log — could not be read",
    remedy: "The .jsonl is malformed. Fix the source or --exclude {id} and re-run.",
    order: 0,
  },
  conflict: {
    reason: "conflict",
    summary: "already uploaded (HTTP 409)",
    remedy: "Safe to ignore — its data is already in Frugl. Clears on next run.",
    order: 1,
  },
  "presign-expired": {
    reason: "presign-expired",
    summary: "upload URL expired (HTTP 403)",
    remedy: "Transient. frugl upload re-presigns and retries it.",
    order: 2,
  },
  network: {
    reason: "network",
    summary: "server error or timeout",
    remedy: "Transient. frugl upload retries it once the endpoint is reachable.",
    order: 3,
  },
  anonymization: {
    reason: "anonymization",
    summary: "local redaction failed — nothing was sent",
    remedy: "Fail-closed: inspect the source; re-run with --dry-run to preview the redaction.",
    order: 4,
  },
  unknown: {
    reason: "unknown",
    summary: "unexpected error",
    remedy: "Re-run frugl upload; if it persists, please report it.",
    order: 5,
  },
};

export interface ClassifiedFailure {
  reason: FailureReason;
  message?: string;
}

// Map a thrown error from the upload pipeline to a fine-grained reason + a
// short human message. HTTP status is the primary signal (409 → conflict,
// 403 → presign-expired, 5xx/other → network); typed errors are honored first.
export function classifyFailure(err: unknown): ClassifiedFailure {
  if (err instanceof AnonymizationError) {
    return { reason: "anonymization", message: err.message };
  }
  if (err instanceof PresignExpiredError) {
    return { reason: "presign-expired", message: err.message };
  }
  if (isParseError(err)) {
    return err instanceof Error ? { reason: "parse", message: err.message } : { reason: "parse" };
  }
  const status = extractStatus(err);
  if (status === 409) return { reason: "conflict", message: "HTTP 409" };
  if (status === 403) return { reason: "presign-expired", message: "HTTP 403" };
  if (status !== undefined) return { reason: "network", message: `HTTP ${status}` };
  if (err instanceof NetworkError) return { reason: "network", message: err.message };
  if (err instanceof Error) return { reason: "network", message: err.message };
  return { reason: "unknown" };
}

// A malformed session log surfaces as a JSON SyntaxError (or a NetworkError-free
// Error tagged parse) before any bytes are sent.
function isParseError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  return (
    err instanceof Error &&
    err.name !== "NetworkError" &&
    /\b(parse|malformed|unexpected token)\b/i.test(err.message)
  );
}

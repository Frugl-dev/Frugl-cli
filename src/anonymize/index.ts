/**
 * Client-side anonymization. Runs BEFORE any byte leaves the user's machine.
 *
 * Policy contract (per constitution Principle VI — Fail-Closed Anonymization):
 *   - Redact API keys / tokens matching well-known provider formats.
 *   - Redact `.env`-shaped lines.
 *   - Redact absolute home-directory paths.
 *   - Redact email addresses other than the authenticated user's own.
 *   - Redact high-entropy strings above documented thresholds.
 *   - Replace identifying values with STABLE PER-UPLOAD pseudonyms so
 *     cross-session joins remain possible without leaking real values.
 *   - On any uncertainty, REDACT (fail-closed). Never pass through "just in case".
 *
 * Implementation lands in this directory under separate files per category,
 * driven by FR-011..FR-015 of specs/001-cloud-ingest-platform/spec.md.
 */
export interface AnonymizeOptions {
  uploadId: string;
  ownerEmail: string;
  policyVersion: string;
}

export interface AnonymizeResult {
  payload: unknown;
  redactions: Record<string, number>;
}

export function anonymize(_input: unknown, _opts: AnonymizeOptions): AnonymizeResult {
  throw new Error("anonymize: not implemented");
}

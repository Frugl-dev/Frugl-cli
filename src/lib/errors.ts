import { EXIT, type ExitCode } from "./exit-codes.js";
import type { OutputMode } from "./output-mode.js";
import { color } from "./theme.js";

export class FruglError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.exitCode = exitCode;
    this.name = new.target.name;
  }
}

export class AuthError extends FruglError {
  // The originating HTTP status (401/403) when the failure came off the wire.
  // `shouldRetry` reads it to suppress pointless retries of auth failures.
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message, EXIT.AUTH_FAILURE);
    if (status !== undefined) this.status = status;
  }
}

export class KeychainError extends FruglError {
  constructor(message: string) {
    super(message, EXIT.KEYCHAIN_UNAVAILABLE);
  }
}

export class AnonymizationError extends FruglError {
  constructor(message: string) {
    super(message, EXIT.ANONYMIZATION_FAILURE);
  }
}

export class NetworkError extends FruglError {
  constructor(message: string) {
    super(message, EXIT.NETWORK_FAILURE);
  }
}

export class EndpointError extends FruglError {
  constructor(message: string) {
    super(message, EXIT.ENDPOINT_UNREACHABLE);
  }
}

export class VersionGateError extends FruglError {
  // Always raised by an HTTP 426; carried so `shouldRetry` never retries it.
  readonly status = 426;
  readonly currentVersion: string;
  readonly requiredVersion: string;
  constructor(currentVersion: string, requiredVersion: string) {
    super(
      `frugl-cli ${currentVersion} is below the minimum supported version ${requiredVersion}. Run: npm install -g frugl@latest`,
      EXIT.VERSION_GATE_FAILURE,
    );
    this.currentVersion = currentVersion;
    this.requiredVersion = requiredVersion;
  }
}

export class NoSessionsError extends FruglError {
  constructor(message: string) {
    super(message, EXIT.NO_SESSIONS_FOUND);
  }
}

// The billing-gate refusal (spec 060): the org is over its plan and the server
// returned a 429 { error: "org_blocked", ... } before any bytes were sent. The
// `reason` discriminates an ended free trial from a hit session limit; `used`,
// `limit`, and `expiresAt` describe the quota, and `upgradeUrl` is where to fix
// it. Carried as the parsed verdict the upload command turns into a warm,
// blame-free message. It is *not* a failure — nothing left the machine and the
// CLI exits 0 (EXIT.OK), so a hook/CI run isn't poisoned by an expected
// business state.
export interface OrgBlockedInfo {
  reason: "trial_expired" | "session_limit_reached";
  used: number;
  limit: number;
  expiresAt: string | null;
  upgradeUrl: string;
}

export class OrgBlockedError extends FruglError {
  readonly reason: OrgBlockedInfo["reason"];
  readonly used: number;
  readonly limit: number;
  readonly expiresAt: string | null;
  readonly upgradeUrl: string;
  constructor(info: OrgBlockedInfo) {
    super(orgBlockedSummary(info), EXIT.OK);
    this.reason = info.reason;
    this.used = info.used;
    this.limit = info.limit;
    this.expiresAt = info.expiresAt;
    this.upgradeUrl = info.upgradeUrl;
  }
}

// One-line fallback message (json/minimal modes, and any path that renders the
// error generically). The rich, mode-aware rendering lives in the upload command.
function orgBlockedSummary(info: OrgBlockedInfo): string {
  if (info.reason === "trial_expired") {
    return `Your Frugl trial has ended — nothing was uploaded. Upgrade to keep shipping sessions: ${info.upgradeUrl}`;
  }
  return `Your org reached its plan limit (${info.used}/${info.limit} sessions) — nothing was uploaded. Upgrade to upload more: ${info.upgradeUrl}`;
}

export class UsageError extends FruglError {
  constructor(message: string) {
    super(message, EXIT.USAGE);
  }
}

export function isFruglError(value: unknown): value is FruglError {
  return value instanceof FruglError;
}

// Reverse-lookup the symbolic name for a stable exit code (e.g. 10 → AUTH_FAILURE).
const EXIT_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(EXIT).map(([name, code]) => [code, name]),
);

export function exitCodeName(code: number): string | undefined {
  return EXIT_NAME[code];
}

// Render an error to stderr in frugl's house style and return the exit code to
// use. FruglErrors get a `frugl: <message>` line plus, in the default format, a
// dim `Exit code N (NAME)` footer matching the design's error screens. The
// json/minimal formats omit the footer. Anything else is reported as a generic
// failure. Never colorizes structured data — picocolors auto-disables on
// non-TTY/NO_COLOR (and minimal forces plain) so piped output stays plain.
export function printFruglError(err: unknown, mode: OutputMode = "default"): ExitCode {
  if (isFruglError(err)) {
    process.stderr.write(`${color.err(`frugl: ${err.message}`)}\n`);
    if (mode === "default") {
      const name = exitCodeName(err.exitCode);
      process.stderr.write(
        `\n${color.dim(`  Exit code ${err.exitCode}${name ? `  (${name})` : ""}`)}\n`,
      );
    }
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${color.err(`frugl: ${message}`)}\n`);
  return EXIT.GENERIC_FAILURE;
}

export class StaleResumeError extends Error {
  readonly manifestId: string;
  constructor(manifestId: string) {
    super(
      `In-flight upload ${manifestId} no longer exists on the cloud. Starting a fresh manifest.`,
    );
    this.manifestId = manifestId;
    this.name = "StaleResumeError";
  }
}

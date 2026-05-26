import { EXIT, type ExitCode } from "./exit-codes.js";
import type { OutputMode } from "./output-mode.js";
import { color } from "./theme.js";

export class PoppiError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.exitCode = exitCode;
    this.name = new.target.name;
  }
}

export class AuthError extends PoppiError {
  constructor(message: string) {
    super(message, EXIT.AUTH_FAILURE);
  }
}

export class KeychainError extends PoppiError {
  constructor(message: string) {
    super(message, EXIT.KEYCHAIN_UNAVAILABLE);
  }
}

export class AnonymizationError extends PoppiError {
  constructor(message: string) {
    super(message, EXIT.ANONYMIZATION_FAILURE);
  }
}

export class NetworkError extends PoppiError {
  constructor(message: string) {
    super(message, EXIT.NETWORK_FAILURE);
  }
}

export class EndpointError extends PoppiError {
  constructor(message: string) {
    super(message, EXIT.ENDPOINT_UNREACHABLE);
  }
}

export class VersionGateError extends PoppiError {
  readonly currentVersion: string;
  readonly requiredVersion: string;
  constructor(currentVersion: string, requiredVersion: string) {
    super(
      `poppi-cli ${currentVersion} is below the minimum supported version ${requiredVersion}. Run: npm install -g poppi@latest`,
      EXIT.VERSION_GATE_FAILURE,
    );
    this.currentVersion = currentVersion;
    this.requiredVersion = requiredVersion;
  }
}

export class NoSessionsError extends PoppiError {
  constructor(message: string) {
    super(message, EXIT.NO_SESSIONS_FOUND);
  }
}

export class InspectDirError extends PoppiError {
  constructor(message: string) {
    super(message, EXIT.INSPECT_DIR_EXISTS);
  }
}

export class UsageError extends PoppiError {
  constructor(message: string) {
    super(message, EXIT.USAGE);
  }
}

export function isPoppiError(value: unknown): value is PoppiError {
  return value instanceof PoppiError;
}

// Reverse-lookup the symbolic name for a stable exit code (e.g. 10 → AUTH_FAILURE).
const EXIT_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(EXIT).map(([name, code]) => [code, name]),
);

export function exitCodeName(code: number): string | undefined {
  return EXIT_NAME[code];
}

// Render an error to stderr in poppi's house style and return the exit code to
// use. PoppiErrors get a `poppi: <message>` line plus, in text mode, a dim
// `Exit code N (NAME)` footer matching the design's error screens. Anything
// else is reported as a generic failure. Never colorizes structured data —
// picocolors auto-disables on non-TTY/NO_COLOR so piped output stays plain.
export function printPoppiError(err: unknown, mode: OutputMode = "text"): ExitCode {
  if (isPoppiError(err)) {
    process.stderr.write(`${color.err(`poppi: ${err.message}`)}\n`);
    if (mode === "text") {
      const name = exitCodeName(err.exitCode);
      process.stderr.write(
        `\n${color.dim(`  Exit code ${err.exitCode}${name ? `  (${name})` : ""}`)}\n`,
      );
    }
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${color.err(`poppi: ${message}`)}\n`);
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

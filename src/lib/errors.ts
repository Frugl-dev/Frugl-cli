import { EXIT, type ExitCode } from "./exit-codes.js";

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

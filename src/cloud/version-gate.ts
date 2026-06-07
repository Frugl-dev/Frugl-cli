import semver from "semver";
import { VersionGateError } from "../lib/errors.js";
import { versionGateBodySchema } from "./schemas.js";

export function checkVersionGate(cliVersion: string, responseBody: unknown): void {
  const parsed = versionGateBodySchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new VersionGateError(cliVersion, "unknown");
  }
  const required = parsed.data.minSupportedCliVersion ?? parsed.data.min_version;
  if (required === undefined) {
    throw new VersionGateError(cliVersion, "unknown");
  }
  const current = semver.coerce(cliVersion)?.version ?? cliVersion;
  const minSupported = semver.coerce(required)?.version ?? required;
  if (semver.lt(current, minSupported)) {
    throw new VersionGateError(cliVersion, required);
  }
}

export function formatVersionGateMessage(currentVersion: string, requiredVersion: string): string {
  return [
    `frugl-cli ${currentVersion} is below the minimum supported version ${requiredVersion}.`,
    `Upgrade with:  npm install -g frugl@latest`,
  ].join("\n");
}

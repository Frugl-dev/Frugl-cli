import { Entry } from "@napi-rs/keyring";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthSession } from "../../auth/session.js";
import { nowIso } from "../../lib/time.js";

const SERVICE = "frugl";

// These helpers seed/clear the credential store the SPAWNED CLI reads. They must
// hit the SAME backend keychain.ts uses: under FRUGL_KEYCHAIN_FILE (set for
// every test by test-setup.ts) that's the hermetic JSON file, so a session
// injected here in the parent is visible to the child process — and, crucially,
// tests never read or mutate the developer's real OS login. The file format
// ({ [account]: token }, account = endpointUrl) mirrors keychain.ts; keep them
// in sync. Absent the env var (defensive only) we fall back to the OS keychain.
function keychainFile(): string | null {
  const path = process.env["FRUGL_KEYCHAIN_FILE"]?.trim();
  return path ? path : null;
}

function readStore(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeStore(path: string, data: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
}

export function injectAuth(session: AuthSession): void {
  const file = keychainFile();
  if (file) {
    const store = readStore(file);
    store[session.endpointUrl] = JSON.stringify(session);
    writeStore(file, store);
    return;
  }
  new Entry(SERVICE, session.endpointUrl).setPassword(JSON.stringify(session));
}

export function clearAuth(endpointUrl: string): void {
  const file = keychainFile();
  if (file) {
    const store = readStore(file);
    if (endpointUrl in store) {
      delete store[endpointUrl];
      writeStore(file, store);
    }
    return;
  }
  try {
    new Entry(SERVICE, endpointUrl).deletePassword();
  } catch {
    // already absent — fine
  }
}

export function makeTestSession(endpointUrl: string): AuthSession {
  return {
    email: "tester@frugl-e2e.example",
    userId: "user-e2e-test",
    token: "tok-e2e-test",
    endpointUrl,
    loggedInAt: nowIso(),
  };
}

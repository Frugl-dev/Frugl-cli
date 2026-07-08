import { Entry } from "@napi-rs/keyring";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KeychainError } from "../lib/errors.js";

export const SERVICE = "frugl";

// Test-isolation seam. When FRUGL_KEYCHAIN_FILE points at a path, credentials
// live in that JSON file ({ [account]: token }) instead of the OS keychain. The
// e2e suite spawns the REAL CLI as a child process, which would otherwise read
// and mutate the developer's genuine `frugl login` — making tests depend on
// ambient machine auth (e.g. a bare-upload "auth-fails" assertion passes in
// headless CI but not on a logged-in laptop). Pointing every test process + its
// spawned children at one temp file makes the store hermetic. NEVER set in
// production: absent the env var, the OS keychain is the only backend.
function fileStorePath(): string | null {
  const path = process.env["FRUGL_KEYCHAIN_FILE"]?.trim();
  return path ? path : null;
}

function readFileStore(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    // Absent or unreadable file == empty store (mirrors "never logged in").
    return {};
  }
}

function writeFileStore(path: string, data: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
}

function entry(account: string): Entry {
  try {
    return new Entry(SERVICE, account);
  } catch (err) {
    throw new KeychainError(
      `OS credential store is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function setToken(account: string, token: string): Promise<void> {
  const filePath = fileStorePath();
  if (filePath) {
    const store = readFileStore(filePath);
    store[account] = token;
    writeFileStore(filePath, store);
    return;
  }
  try {
    entry(account).setPassword(token);
  } catch (err) {
    throw new KeychainError(
      `Failed to write to OS credential store: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getToken(account: string): Promise<string | null> {
  const filePath = fileStorePath();
  if (filePath) return readFileStore(filePath)[account] ?? null;
  try {
    return entry(account).getPassword() ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not\s*found|no matching/i.test(message)) {
      return null;
    }
    throw new KeychainError(`Failed to read from OS credential store: ${message}`);
  }
}

export async function deleteToken(account: string): Promise<void> {
  const filePath = fileStorePath();
  if (filePath) {
    const store = readFileStore(filePath);
    if (account in store) {
      delete store[account];
      writeFileStore(filePath, store);
    }
    return;
  }
  try {
    entry(account).deletePassword();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not\s*found|no matching/i.test(message)) return;
    throw new KeychainError(`Failed to delete from OS credential store: ${message}`);
  }
}

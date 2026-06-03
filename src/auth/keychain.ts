import { Entry } from "@napi-rs/keyring";
import { KeychainError } from "../lib/errors.js";

export const SERVICE = "frugl";

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
  try {
    entry(account).setPassword(token);
  } catch (err) {
    throw new KeychainError(
      `Failed to write to OS credential store: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getToken(account: string): Promise<string | null> {
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
  try {
    entry(account).deletePassword();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not\s*found|no matching/i.test(message)) return;
    throw new KeychainError(`Failed to delete from OS credential store: ${message}`);
  }
}

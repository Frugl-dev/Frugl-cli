import { deleteToken, getToken, setToken } from "./keychain.js";

// Port: a minimal secret key/value store keyed by account. Decouples the
// session logic from where credentials physically live. The production adapter
// is the OS keychain; tests inject the in-memory adapter so the whole
// SessionStore can be exercised at its boundary without touching the real OS
// credential store or mocking individual functions.
export interface CredentialStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

// Production adapter: the OS keychain via @napi-rs/keyring (see keychain.ts).
export const keychainCredentialStore: CredentialStore = {
  get: getToken,
  set: setToken,
  delete: deleteToken,
};

// Test adapter: an in-process map. `seed` pre-populates accounts.
export function createInMemoryCredentialStore(seed?: Record<string, string>): CredentialStore {
  const map = new Map<string, string>(seed ? Object.entries(seed) : undefined);
  return {
    async get(account) {
      return map.get(account) ?? null;
    },
    async set(account, value) {
      map.set(account, value);
    },
    async delete(account) {
      map.delete(account);
    },
  };
}

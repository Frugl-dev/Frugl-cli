/**
 * Token storage in the OS-appropriate credential store.
 * macOS Keychain / Windows Credential Manager / libsecret on Linux.
 *
 * Per constitution Principle II, tokens MUST NOT live in a plaintext file
 * in the home directory.
 */
const SERVICE = "poppi";

export async function setToken(_account: string, _token: string): Promise<void> {
  throw new Error("keychain.setToken: not implemented (use keytar or platform fallback)");
}

export async function getToken(_account: string): Promise<string | null> {
  throw new Error("keychain.getToken: not implemented");
}

export async function deleteToken(_account: string): Promise<void> {
  throw new Error("keychain.deleteToken: not implemented");
}

export { SERVICE };

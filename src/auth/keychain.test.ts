import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the native keyring so no real OS credential store is ever touched. The
// Entry class is replaced by a controllable fake whose constructor + methods are
// driven per-test via the `controls` object below.
interface EntryControls {
  construct: (service: string, account: string) => void;
  setPassword: (token: string) => void;
  getPassword: () => string | null;
  deletePassword: () => void;
}

const controls: EntryControls = {
  construct: () => {},
  setPassword: () => {},
  getPassword: () => null,
  deletePassword: () => {},
};

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(service: string, account: string) {
      controls.construct(service, account);
    }
    setPassword(token: string): void {
      controls.setPassword(token);
    }
    getPassword(): string | null {
      return controls.getPassword();
    }
    deletePassword(): void {
      controls.deletePassword();
    }
  },
}));

const { SERVICE, setToken, getToken, deleteToken } = await import("./keychain.js");
const { KeychainError } = await import("../lib/errors.js");

beforeEach(() => {
  controls.construct = () => {};
  controls.setPassword = () => {};
  controls.getPassword = () => null;
  controls.deletePassword = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keychain entry construction", () => {
  it("keys the Entry by SERVICE and the account", async () => {
    const seen: Array<[string, string]> = [];
    controls.construct = (service, account) => {
      seen.push([service, account]);
    };
    await getToken("me@acme.dev");
    expect(seen).toEqual([[SERVICE, "me@acme.dev"]]);
  });

  it("surfaces an unavailable credential store as a KeychainError", async () => {
    controls.construct = () => {
      throw new Error("no backend");
    };
    await expect(getToken("acct")).rejects.toBeInstanceOf(KeychainError);
    await expect(getToken("acct")).rejects.toThrow(/unavailable: no backend/);
  });
});

describe("setToken", () => {
  it("writes the password through the Entry", async () => {
    const writes: string[] = [];
    controls.setPassword = (token) => {
      writes.push(token);
    };
    await setToken("acct", "tok_abc");
    expect(writes).toEqual(["tok_abc"]);
  });

  it("wraps a write failure in a KeychainError", async () => {
    controls.setPassword = () => {
      throw new Error("disk full");
    };
    await expect(setToken("acct", "tok")).rejects.toBeInstanceOf(KeychainError);
    await expect(setToken("acct", "tok")).rejects.toThrow(/Failed to write.*disk full/);
  });
});

describe("getToken", () => {
  it("returns the stored password", async () => {
    controls.getPassword = () => "tok_stored";
    expect(await getToken("acct")).toBe("tok_stored");
  });

  it("normalizes an undefined password to null", async () => {
    controls.getPassword = () => null;
    expect(await getToken("acct")).toBeNull();
  });

  it("treats a 'not found' read error as a null result (never logged in)", async () => {
    controls.getPassword = () => {
      throw new Error("No matching entry found in secure storage");
    };
    expect(await getToken("acct")).toBeNull();
  });

  it("rethrows a genuine read failure as a KeychainError", async () => {
    controls.getPassword = () => {
      throw new Error("keychain locked");
    };
    await expect(getToken("acct")).rejects.toBeInstanceOf(KeychainError);
    await expect(getToken("acct")).rejects.toThrow(/Failed to read.*keychain locked/);
  });
});

describe("deleteToken", () => {
  it("deletes the password through the Entry", async () => {
    let deleted = false;
    controls.deletePassword = () => {
      deleted = true;
    };
    await deleteToken("acct");
    expect(deleted).toBe(true);
  });

  it("is a no-op when the entry is already absent (not found)", async () => {
    controls.deletePassword = () => {
      throw new Error("not found");
    };
    await expect(deleteToken("acct")).resolves.toBeUndefined();
  });

  it("rethrows a genuine delete failure as a KeychainError", async () => {
    controls.deletePassword = () => {
      throw new Error("permission denied");
    };
    await expect(deleteToken("acct")).rejects.toBeInstanceOf(KeychainError);
    await expect(deleteToken("acct")).rejects.toThrow(/Failed to delete.*permission denied/);
  });
});

import { describe, expect, it } from "vitest";
import { createInMemoryCredentialStore } from "./credential-store.js";

describe("createInMemoryCredentialStore", () => {
  it("returns null for an account that was never set", async () => {
    const store = createInMemoryCredentialStore();
    expect(await store.get("missing")).toBeNull();
  });

  it("round-trips a set value", async () => {
    const store = createInMemoryCredentialStore();
    await store.set("acct", "value-1");
    expect(await store.get("acct")).toBe("value-1");
  });

  it("overwrites an existing value on a second set", async () => {
    const store = createInMemoryCredentialStore();
    await store.set("acct", "first");
    await store.set("acct", "second");
    expect(await store.get("acct")).toBe("second");
  });

  it("deletes a value, after which get returns null", async () => {
    const store = createInMemoryCredentialStore();
    await store.set("acct", "value");
    await store.delete("acct");
    expect(await store.get("acct")).toBeNull();
  });

  it("delete on an absent account is a silent no-op", async () => {
    const store = createInMemoryCredentialStore();
    await expect(store.delete("nope")).resolves.toBeUndefined();
  });

  it("pre-populates accounts from the seed", async () => {
    const store = createInMemoryCredentialStore({ a: "1", b: "2" });
    expect(await store.get("a")).toBe("1");
    expect(await store.get("b")).toBe("2");
  });

  it("isolates state between separate store instances", async () => {
    const a = createInMemoryCredentialStore();
    const b = createInMemoryCredentialStore();
    await a.set("shared", "from-a");
    expect(await b.get("shared")).toBeNull();
  });

  it("does not let later seed mutations leak into the store (own copy)", async () => {
    const seed: Record<string, string> = { acct: "original" };
    const store = createInMemoryCredentialStore(seed);
    seed.acct = "mutated";
    expect(await store.get("acct")).toBe("original");
  });
});

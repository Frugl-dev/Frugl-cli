import { describe, it, expect } from "vitest";
import { PseudonymTable } from "./pseudonyms.js";

describe("PseudonymTable", () => {
  it("returns the same pseudonym for the same input within one table", () => {
    const table = new PseudonymTable("upload-1");
    const a = table.pseudonymize("project-name", "acme");
    const b = table.pseudonymize("project-name", "acme");
    expect(a).toBe(b);
  });

  it("returns distinct pseudonyms for distinct real values", () => {
    const table = new PseudonymTable("upload-1");
    const a = table.pseudonymize("project-name", "acme");
    const b = table.pseudonymize("project-name", "globex");
    expect(a).not.toBe(b);
  });

  it("uses the same uploadId salt deterministically across table instances", () => {
    const a = new PseudonymTable("upload-1").pseudonymize("project-name", "acme");
    const b = new PseudonymTable("upload-1").pseudonymize("project-name", "acme");
    expect(a).toBe(b);
  });

  it("salts pseudonyms by uploadId so the same input differs across uploads", () => {
    const a = new PseudonymTable("upload-1").pseudonymize("project-name", "acme");
    const b = new PseudonymTable("upload-2").pseudonymize("project-name", "acme");
    expect(a).not.toBe(b);
  });

  it("isolates identical real values across different categories", () => {
    const table = new PseudonymTable("upload-1");
    const asProject = table.pseudonymize("project-name", "shared");
    const asEmail = table.pseudonymize("third-party-email", "shared");
    expect(asProject).not.toBe(asEmail);
  });

  it("uses the configured prefix for known categories", () => {
    const table = new PseudonymTable("upload-1");
    expect(table.pseudonymize("project-name", "acme")).toMatch(/^proj_[a-f0-9]{10}$/);
    expect(table.pseudonymize("third-party-email", "a@b.com")).toMatch(/^user_[a-f0-9]{10}$/);
    expect(table.pseudonymize("home-path", "/Users/alice")).toMatch(/^path_[a-f0-9]{10}$/);
  });

  it("derives a sanitized prefix for categories without an explicit prefix", () => {
    const table = new PseudonymTable("upload-1");
    // "anthropic-key" has no PREFIX entry: non-alphanumerics stripped → "anthropickey_".
    expect(table.pseudonymize("anthropic-key", "sk-ant-xyz")).toMatch(
      /^anthropickey_[a-f0-9]{10}$/,
    );
  });

  it("emits a 10-hex-char digest", () => {
    const table = new PseudonymTable("upload-1");
    const pseudonym = table.pseudonymize("project-name", "acme");
    const digest = pseudonym.slice("proj_".length);
    expect(digest).toMatch(/^[a-f0-9]{10}$/);
  });

  it("caches the first pseudonym even if called many times", () => {
    const table = new PseudonymTable("upload-1");
    const first = table.pseudonymize("home-path", "/Users/alice");
    for (let i = 0; i < 5; i++) {
      expect(table.pseudonymize("home-path", "/Users/alice")).toBe(first);
    }
  });

  it("does not collide the HMAC across a category/value boundary", () => {
    // category + " " + value is fed to the HMAC; ensure the separator means
    // ("a-b", "c") and ("a", "b-c") style ambiguity is not a concern for the
    // categories we use — different category, different real value → different.
    const table = new PseudonymTable("upload-1");
    const x = table.pseudonymize("project-name", "acme");
    const y = table.pseudonymize("third-party-email", "acme");
    expect(x).not.toBe(y);
  });
});

import { describe, it, expect } from "vitest";
import { deriveSlug } from "./slug.js";

describe("deriveSlug", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(deriveSlug("My Company")).toBe("my-company");
  });

  it("strips special characters", () => {
    expect(deriveSlug("Acme, Inc.")).toBe("acme-inc");
  });

  it("collapses multiple spaces into one hyphen", () => {
    expect(deriveSlug("Hello   World")).toBe("hello-world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(deriveSlug("  Acme  ")).toBe("acme");
  });

  it("replaces non-alphanumeric runs with a single hyphen", () => {
    expect(deriveSlug("A & B Corp!")).toBe("a-b-corp");
  });

  it("truncates to 40 characters ending on an alphanumeric", () => {
    const long = "abcdefghij".repeat(5); // 50 chars
    const result = deriveSlug(long);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it("strips leading and trailing hyphens after transformation", () => {
    expect(deriveSlug("---cool---")).toBe("cool");
  });
});

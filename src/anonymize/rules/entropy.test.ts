import { describe, it, expect } from "vitest";
import { PseudonymTable } from "../pseudonyms.js";
import { entropyRule, isHighEntropy, shannonEntropy } from "./entropy.js";
import type { RuleContext } from "./types.js";

const ctx: RuleContext = {
  pseudonyms: new PseudonymTable("u-entropy"),
  ownerEmail: "owner@example.com",
};

describe("shannonEntropy / isHighEntropy", () => {
  it("returns 0 for an empty string", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  it("returns 0 for a single repeated character", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
  });

  it("computes higher entropy for more varied content", () => {
    expect(shannonEntropy("abcdefgh")).toBeGreaterThan(shannonEntropy("aaaaaaab"));
  });

  it("rejects strings shorter than the minimum length", () => {
    // High variety but only 8 chars — below the 20-char minimum.
    expect(isHighEntropy("abcdefgh")).toBe(false);
  });

  it("covers the entropy threshold boundary", () => {
    // A long run of a single character has entropy 0 — below the 4.5 bits/char
    // threshold even though it clears the length minimum.
    const lowEntropyLong = "a".repeat(40);
    expect(lowEntropyLong.length).toBeGreaterThanOrEqual(20);
    expect(shannonEntropy(lowEntropyLong)).toBeLessThan(4.5);
    expect(isHighEntropy(lowEntropyLong)).toBe(false);

    // A varied base64-ish blob of sufficient length clears the threshold.
    const highEntropyLong = "Zm9vYmFyYmF6YnV6QUJDREVGRzEyMzQ1Njc4OWFiYw";
    expect(shannonEntropy(highEntropyLong)).toBeGreaterThanOrEqual(4.5);
    expect(isHighEntropy(highEntropyLong)).toBe(true);
  });
});

describe("entropyRule", () => {
  it("has the expected id and categories", () => {
    expect(entropyRule.id).toBe("entropy");
    expect(entropyRule.categories).toEqual(["entropy-fallback"]);
  });

  it("redacts a high-entropy blob and counts it", () => {
    const planted = "Zm9vYmFyYmF6YnV6QUJDREVGRzEyMzQ1Njc4OWFiYw";
    const { output, counts } = entropyRule.apply(`raw=${planted}`, ctx);
    expect(output).not.toContain(planted);
    expect(output).toContain("<REDACTED:entropy-fallback>");
    expect(counts["entropy-fallback"]).toBe(1);
  });

  it("does not re-redact an already-redacted span", () => {
    const input = "value <REDACTED:anthropic-key> stays put";
    const { output, counts } = entropyRule.apply(input, ctx);
    expect(output).toBe(input);
    expect(counts["entropy-fallback"]).toBeUndefined();
  });

  it("is a no-op on benign low-entropy input", () => {
    const benign = "the quick brown fox jumps over the lazy dog";
    const { output, counts } = entropyRule.apply(benign, ctx);
    expect(output).toBe(benign);
    expect(Object.keys(counts)).toHaveLength(0);
  });
});

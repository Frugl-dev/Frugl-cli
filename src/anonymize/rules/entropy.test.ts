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

  it("redacts hex-only tokens of 32+ chars (unreachable by the 4.5 bits/char bar)", () => {
    const hexToken = "a3f9c2e8b1d04756e9fa8c3b2d1e0f47"; // 32 hex chars, Twilio-style
    const { output, counts } = entropyRule.apply(`token: ${hexToken}`, ctx);
    expect(output).not.toContain(hexToken);
    expect(counts["entropy-fallback"]).toBe(1);

    const sha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    expect(entropyRule.apply(sha256, ctx).output).toBe("<REDACTED:entropy-fallback>");
  });

  it("leaves short or repetitive hex strings alone", () => {
    const shortHex = "deadbeefdeadbeef1234"; // 20 chars: under the 32-char hex minimum
    expect(entropyRule.apply(shortHex, ctx).output).toBe(shortHex);

    const repetitive = "ababababababababababababababababab";
    expect(entropyRule.apply(repetitive, ctx).output).toBe(repetitive);
  });

  it("scores base64 material containing '/' as a whole", () => {
    // AWS secret access keys are 40-char base64 including '/'; splitting on '/'
    // would leave each fragment below the length/entropy bar.
    const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const { output, counts } = entropyRule.apply(`secret ${awsSecret} end`, ctx);
    expect(output).not.toContain(awsSecret);
    expect(counts["entropy-fallback"]).toBe(1);
  });

  it("is a no-op on benign low-entropy input", () => {
    const benign = "the quick brown fox jumps over the lazy dog";
    const { output, counts } = entropyRule.apply(benign, ctx);
    expect(output).toBe(benign);
    expect(Object.keys(counts)).toHaveLength(0);
  });
});

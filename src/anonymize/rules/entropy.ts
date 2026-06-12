import type { RedactionCategory } from "../policy.js";
import type { Rule } from "./types.js";

const MIN_LENGTH = 20;
const MIN_ENTROPY_BITS_PER_CHAR = 4.5;
// Shannon entropy is bounded by log2(alphabet size), so hex material tops out
// at 4.0 bits/char and can never clear the general 4.5 threshold. Hex-only
// candidates get their own bar: random hex of 32+ chars sits around 3.9.
// 32 is the shortest common hex secret (Twilio auth tokens, MD5-sized keys).
const HEX_MIN_LENGTH = 32;
const HEX_MIN_ENTROPY_BITS_PER_CHAR = 3.7;
// `/` is included so base64 material (PEM bodies, AWS secret access keys)
// is scored whole instead of being split into low-entropy fragments.
const CANDIDATE_REGEX = /[A-Za-z0-9_+/=-]{20,}/g;
const HEX_REGEX = /^[0-9a-fA-F]+$/;

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const len = value.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function isHighEntropy(value: string): boolean {
  if (value.length < MIN_LENGTH) return false;
  if (HEX_REGEX.test(value)) {
    if (value.length < HEX_MIN_LENGTH) return false;
    return shannonEntropy(value) >= HEX_MIN_ENTROPY_BITS_PER_CHAR;
  }
  return shannonEntropy(value) >= MIN_ENTROPY_BITS_PER_CHAR;
}

export function redactEntropy(input: string): {
  output: string;
  counts: Partial<Record<RedactionCategory, number>>;
} {
  const counts: Partial<Record<RedactionCategory, number>> = {};
  const output = input.replace(CANDIDATE_REGEX, (match) => {
    if (!isHighEntropy(match)) return match;
    counts["entropy-fallback"] = (counts["entropy-fallback"] ?? 0) + 1;
    return "<REDACTED:entropy-fallback>";
  });
  return { output, counts };
}

export const entropyRule: Rule = {
  id: "entropy",
  categories: ["entropy-fallback"],
  apply: (input) => redactEntropy(input),
};

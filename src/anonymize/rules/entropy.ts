import type { RedactionCategory } from "../policy.js";
import type { Rule } from "./types.js";

const MIN_LENGTH = 20;
const MIN_ENTROPY_BITS_PER_CHAR = 4.5;
const CANDIDATE_REGEX = /[A-Za-z0-9_+=-]{20,}/g;

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
  return shannonEntropy(value) >= MIN_ENTROPY_BITS_PER_CHAR;
}

export function redactEntropy(input: string): {
  output: string;
  counts: Partial<Record<RedactionCategory, number>>;
} {
  const counts: Partial<Record<RedactionCategory, number>> = {};
  const output = input.replace(CANDIDATE_REGEX, (match) => {
    if (!isHighEntropy(match)) return match;
    if (match.startsWith("<REDACTED")) return match;
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

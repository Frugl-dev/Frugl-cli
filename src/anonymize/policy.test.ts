import { describe, it, expect } from "vitest";
import { RULES } from "./rules/registry.js";
import { POLICY_VERSION, REDACTION_CATEGORIES, type RedactionCategory } from "./policy.js";

// The complete, ordered category list. This is the deduped flatten of every
// rule's `categories` in registry order (secrets → claude-paths → emails →
// entropy) and must stay identical to the historical literal below. Any drift
// fails CI and forces a deliberate POLICY_VERSION bump.
const EXPECTED_ORDER: readonly RedactionCategory[] = [
  "anthropic-key",
  "openai-key",
  "aws-key",
  "gcp-key",
  "private-key",
  "github-token",
  "slack-webhook",
  "jwt",
  "connection-string",
  "bearer-token",
  "provider-token",
  "env-line",
  "home-path",
  "project-name",
  "third-party-email",
  "entropy-fallback",
];

describe("policy", () => {
  it("locks the policy version", () => {
    expect(POLICY_VERSION).toBe("v0.2");
  });

  it("locks the exact ordered category list", () => {
    expect(REDACTION_CATEGORIES).toEqual(EXPECTED_ORDER);
  });

  it("contains no duplicate categories", () => {
    expect(new Set(REDACTION_CATEGORIES).size).toBe(REDACTION_CATEGORIES.length);
  });

  it("matches the deduped flatten of the live ruleset", () => {
    const seen = new Set<RedactionCategory>();
    const fromRules: RedactionCategory[] = [];
    for (const rule of RULES) {
      for (const category of rule.categories) {
        if (seen.has(category)) continue;
        seen.add(category);
        fromRules.push(category);
      }
    }
    expect([...REDACTION_CATEGORIES]).toEqual(fromRules);
  });

  it("includes every category emitted by every rule", () => {
    const categorySet = new Set(REDACTION_CATEGORIES);
    for (const rule of RULES) {
      for (const category of rule.categories) {
        expect(categorySet.has(category)).toBe(true);
      }
    }
  });
});

import { describe, it, expect } from "vitest";
import { POLICY_VERSION, REDACTION_CATEGORIES, type RedactionCategory } from "../policy.js";
import { RULES } from "./registry.js";

function dedupe(categories: readonly RedactionCategory[]): RedactionCategory[] {
  return [...new Set(categories)];
}

describe("rule registry coherence", () => {
  it("derives REDACTION_CATEGORIES from the deduped flatten of RULES", () => {
    const fromRules = dedupe(RULES.flatMap((rule) => rule.categories));
    expect([...REDACTION_CATEGORIES]).toEqual(fromRules);
  });

  it("has set-equality between REDACTION_CATEGORIES and the rule categories", () => {
    const fromRules = new Set(RULES.flatMap((rule) => rule.categories));
    const fromPolicy = new Set(REDACTION_CATEGORIES);
    expect(fromRules).toEqual(fromPolicy);
  });

  it("has unique rule ids", () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the security-relevant ordering: secrets → claude-paths → emails → entropy", () => {
    expect(RULES.map((rule) => rule.id)).toEqual(["secrets", "claude-paths", "emails", "entropy"]);
  });

  it("runs secrets before entropy (structured before catch-all)", () => {
    const ids = RULES.map((rule) => rule.id);
    expect(ids.indexOf("secrets")).toBeLessThan(ids.indexOf("entropy"));
  });

  it("runs paths before emails (paths may contain @ segments)", () => {
    const ids = RULES.map((rule) => rule.id);
    expect(ids.indexOf("claude-paths")).toBeLessThan(ids.indexOf("emails"));
  });

  it("runs entropy last as the catch-all", () => {
    expect(RULES[RULES.length - 1]!.id).toBe("entropy");
  });

  // Snapshot of (POLICY_VERSION, ordered category list). A deliberate reorder or
  // category change must bump POLICY_VERSION; otherwise this snapshot fails CI,
  // forcing the security-review-required decision to be explicit.
  it("snapshots the policy version and ordered category list", () => {
    expect({
      policyVersion: POLICY_VERSION,
      categories: [...REDACTION_CATEGORIES],
    }).toMatchInlineSnapshot(`
      {
        "categories": [
          "anthropic-key",
          "openai-key",
          "aws-key",
          "gcp-key",
          "github-token",
          "slack-webhook",
          "env-line",
          "home-path",
          "project-name",
          "third-party-email",
          "entropy-fallback",
        ],
        "policyVersion": "v0.1",
      }
    `);
  });
});

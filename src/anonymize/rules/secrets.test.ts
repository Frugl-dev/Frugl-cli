import { describe, it, expect } from "vitest";
import { PseudonymTable } from "../pseudonyms.js";
import { secretsRule } from "./secrets.js";
import type { RuleContext } from "./types.js";

const ctx: RuleContext = {
  pseudonyms: new PseudonymTable("u-secrets"),
  ownerEmail: "owner@example.com",
};

const PLANTED = {
  "anthropic-key": "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "openai-key": "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "aws-key": "AKIAIOSFODNN7EXAMPLE",
  "gcp-key":
    '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEAv1\\n-----END PRIVATE KEY-----\\n"',
  "github-token": "ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  "slack-webhook": "https://hooks.slack.com/services/T0000/B1111/abcdefghijklmnop",
} as const;

describe("secretsRule", () => {
  it("has the expected id and categories", () => {
    expect(secretsRule.id).toBe("secrets");
    expect(secretsRule.categories).toEqual([
      "anthropic-key",
      "openai-key",
      "aws-key",
      "gcp-key",
      "github-token",
      "slack-webhook",
      "env-line",
    ]);
  });

  it("removes each planted structured secret and counts its category", () => {
    for (const [category, value] of Object.entries(PLANTED)) {
      const { output, counts } = secretsRule.apply(`prefix ${value} suffix`, ctx);
      expect(output).not.toContain(value.replace(/^"private_key": "/, ""));
      expect(output).toContain(`<REDACTED:${category}>`);
      expect(counts[category as keyof typeof PLANTED]).toBe(1);
    }
  });

  it("redacts an env-line value while keeping the key", () => {
    const { output, counts } = secretsRule.apply("DATABASE_URL=postgres://user:pass@host/db", ctx);
    expect(output).toBe("DATABASE_URL=<REDACTED:env-line>");
    expect(counts["env-line"]).toBe(1);
    expect(output).not.toContain("postgres");
  });

  it("is a no-op on benign input", () => {
    const benign = "just a normal sentence with no secrets at all";
    const { output, counts } = secretsRule.apply(benign, ctx);
    expect(output).toBe(benign);
    expect(Object.keys(counts)).toHaveLength(0);
  });
});

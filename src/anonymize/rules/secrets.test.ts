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
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
} as const;

describe("secretsRule", () => {
  it("has the expected id and categories", () => {
    expect(secretsRule.id).toBe("secrets");
    expect(secretsRule.categories).toEqual([
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

  it("redacts double- and single-quoted env values", () => {
    const dq = secretsRule.apply('API_KEY="zX9plq3vR8wn2tCkfQ"', ctx);
    expect(dq.output).toBe("API_KEY=<REDACTED:env-line>");
    expect(dq.output).not.toContain("zX9plq3vR8wn2tCkfQ");

    const sq = secretsRule.apply("export APP_SECRET='hunter2hunter2hunter2'", ctx);
    expect(sq.output).toBe("export APP_SECRET=<REDACTED:env-line>");
    expect(sq.output).not.toContain("hunter2");
  });

  it("leaves benign all-caps assignments with boolean/numeric values alone", () => {
    const { output } = secretsRule.apply("DEBUG=true RETRIES=3 PORT=8080", ctx);
    expect(output).toBe("DEBUG=true RETRIES=3 PORT=8080");
  });

  it("leaves $VAR references and <placeholders> alone", () => {
    const { output } = secretsRule.apply(
      'API_KEY="$MY_KEY" TOKEN=${OTHER} SECRET=<your-secret>',
      ctx,
    );
    expect(output).toContain("$MY_KEY");
    expect(output).toContain("${OTHER}");
    expect(output).toContain("<your-secret>");
  });

  it("redacts lowercase secret-named assignments (aws_secret_access_key style)", () => {
    const { output, counts } = secretsRule.apply(
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      ctx,
    );
    expect(output).not.toContain("wJalrXUtnFEMI");
    expect(output).toContain("aws_secret_access_key = <REDACTED:env-line>");
    expect(counts["env-line"]).toBe(1);
  });

  it("redacts secret-named JSON and YAML values, preserving structure", () => {
    const json = secretsRule.apply('{"apiKey": "abcd1234efgh5678"}', ctx);
    expect(json.output).toBe('{"apiKey": <REDACTED:env-line>}');

    const yaml = secretsRule.apply("password: correcthorsebatterystaple", ctx);
    expect(yaml.output).toBe("password: <REDACTED:env-line>");
  });

  it("redacts Authorization headers", () => {
    const { output, counts } = secretsRule.apply(
      'curl -H "Authorization: Bearer abc123def456ghi789" https://api.example.com',
      ctx,
    );
    expect(output).not.toContain("abc123def456ghi789");
    expect(output).toContain("Authorization: Bearer <REDACTED:bearer-token>");
    expect(counts["bearer-token"]).toBe(1);
  });

  it("redacts connection-string passwords but keeps scheme, user, and host", () => {
    const { output, counts } = secretsRule.apply(
      "postgres://admin:Sup3rS3cret@localhost:5432/db",
      ctx,
    );
    expect(output).toBe("postgres://admin:<REDACTED:connection-string>@localhost:5432/db");
    expect(counts["connection-string"]).toBe(1);
  });

  it("redacts raw PEM private key blocks (real and escaped newlines)", () => {
    const raw = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7/C7+VVVVVVVV",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const result = secretsRule.apply(raw, ctx);
    expect(result.output).toBe("<REDACTED:private-key>");
    expect(result.counts["private-key"]).toBe(1);

    const escaped = secretsRule.apply(
      "-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAA\\n-----END OPENSSH PRIVATE KEY-----",
      ctx,
    );
    expect(escaped.output).toBe("<REDACTED:private-key>");
  });

  it("redacts Stripe, Slack, npm, and GitLab tokens as provider-token", () => {
    // Fixtures assembled at runtime so no token-shaped literal lands in the
    // repo (GitHub push protection scans source verbatim).
    const samples = [
      ["sk_live", "abcdefghijklmnop1234"].join("_"),
      ["xoxb", "1234567890", "abcdefghijklmnop"].join("-"),
      ["npm", "abcdefghijklmnopqrstuvwxyz123456"].join("_"),
      ["glpat", "abcdefghij1234567890"].join("-"),
    ];
    for (const sample of samples) {
      const { output, counts } = secretsRule.apply(`token here: ${sample} done`, ctx);
      expect(output).not.toContain(sample);
      expect(output).toContain("<REDACTED:provider-token>");
      expect(counts["provider-token"]).toBe(1);
    }
  });

  it("does not corrupt hyphenated identifiers resembling key prefixes", () => {
    const benign = "the task-12345678901234567890abc item";
    const { output } = secretsRule.apply(benign, ctx);
    expect(output).toBe(benign);
  });

  it("does not double-count a structured secret inside an env assignment", () => {
    const { output, counts } = secretsRule.apply(
      "ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ctx,
    );
    expect(output).toBe("ANTHROPIC_API_KEY=<REDACTED:anthropic-key>");
    expect(counts["anthropic-key"]).toBe(1);
    expect(counts["env-line"]).toBeUndefined();
  });

  it("is a no-op on benign input", () => {
    const benign = "just a normal sentence with no secrets at all";
    const { output, counts } = secretsRule.apply(benign, ctx);
    expect(output).toBe(benign);
    expect(Object.keys(counts)).toHaveLength(0);
  });
});

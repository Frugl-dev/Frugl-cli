import { describe, it, expect } from "vitest";
import { anonymize, POLICY_VERSION, PseudonymTable } from "./index.js";

const PLANTED = {
  "anthropic-key": "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "openai-key": "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "aws-key": "AKIAIOSFODNN7EXAMPLE",
  "gcp-key":
    '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEAv1\\n-----END PRIVATE KEY-----\\n"',
  "github-token": "ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  "slack-webhook": "https://hooks.slack.com/services/T0000/B1111/abcdefghijklmnop",
  "env-line": "DATABASE_URL=postgres://user:pass@host/db",
  "home-path": "/Users/alice/.claude/projects/acme-secret/main.ts",
  "third-party-email": "someone-else@example.com",
  "entropy-fallback": "Zm9vYmFyYmF6YnV6QUJDREVGRzEyMzQ1Njc4OWFiYw",
} as const;

const OWNER_EMAIL = "owner@example.com";
const PROJ_RE = /proj_[a-f0-9]+/;

function buildFixture(home: string) {
  const homePathInHome = `${home}/.claude/projects/acme-secret/main.ts`;
  return {
    sessions: [
      {
        id: "s1",
        text: `here is the anthropic key ${PLANTED["anthropic-key"]} and the openai ${PLANTED["openai-key"]}`,
      },
      {
        id: "s2",
        text: `aws=${PLANTED["aws-key"]} gh=${PLANTED["github-token"]} env: ${PLANTED["env-line"]}`,
      },
      {
        id: "s3",
        text: `slack hook ${PLANTED["slack-webhook"]} gcp: { ${PLANTED["gcp-key"]} }`,
      },
      {
        id: "s4",
        text: `opened ${homePathInHome} for ${PLANTED["third-party-email"]}; cc ${OWNER_EMAIL}; raw=${PLANTED["entropy-fallback"]}`,
      },
    ],
  };
}

describe("anonymize", () => {
  it("removes every planted secret value from the serialized payload", () => {
    const home = "/Users/alice";
    const result = anonymize(buildFixture(home), {
      uploadId: "u-test",
      ownerEmail: OWNER_EMAIL,
      homeDir: home,
    });
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain(PLANTED["anthropic-key"]);
    expect(serialized).not.toContain(PLANTED["openai-key"]);
    expect(serialized).not.toContain(PLANTED["aws-key"]);
    expect(serialized).not.toContain(PLANTED["github-token"]);
    expect(serialized).not.toContain(PLANTED["slack-webhook"]);
    expect(serialized).not.toContain("DATABASE_URL=postgres");
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain(PLANTED["third-party-email"]);
    expect(serialized).not.toContain(PLANTED["entropy-fallback"]);
    expect(serialized).not.toContain("MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8");
  });

  it("preserves the authenticated user's own email", () => {
    const home = "/Users/alice";
    const result = anonymize(buildFixture(home), {
      uploadId: "u-test",
      ownerEmail: OWNER_EMAIL,
      homeDir: home,
    });
    expect(JSON.stringify(result.payload)).toContain(OWNER_EMAIL);
  });

  it("reports a redaction count for every category that fired", () => {
    const home = "/Users/alice";
    const result = anonymize(buildFixture(home), {
      uploadId: "u-test",
      ownerEmail: OWNER_EMAIL,
      homeDir: home,
    });
    expect(result.redactionsByCategory["anthropic-key"]).toBeGreaterThanOrEqual(1);
    expect(result.redactionsByCategory["openai-key"]).toBeGreaterThanOrEqual(1);
    expect(result.redactionsByCategory["aws-key"]).toBe(1);
    expect(result.redactionsByCategory["github-token"]).toBe(1);
    expect(result.redactionsByCategory["slack-webhook"]).toBe(1);
    expect(result.redactionsByCategory["env-line"]).toBeGreaterThanOrEqual(1);
    expect(result.redactionsByCategory["home-path"]).toBeGreaterThanOrEqual(1);
    expect(result.redactionsByCategory["project-name"]).toBeGreaterThanOrEqual(1);
    expect(result.redactionsByCategory["third-party-email"]).toBe(1);
    expect(result.redactionsByCategory["gcp-key"]).toBe(1);
  });

  it("records the policy version, byte size, and content hash", () => {
    const result = anonymize(
      { text: "hello" },
      {
        uploadId: "u",
        ownerEmail: OWNER_EMAIL,
      },
    );
    expect(result.policyVersion).toBe(POLICY_VERSION);
    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.redactedHashHex).toMatch(/^[a-f0-9]{64}$/);
    expect(result.contentHashHex).toMatch(/^[a-f0-9]{64}$/);
  });

  it("contentHashHex is uploadId-independent but sensitive to input and policy", () => {
    const base = anonymize({ text: "hello" }, { uploadId: "u", ownerEmail: OWNER_EMAIL });
    // Same input, different uploadId (different pseudonym salt) → same hash.
    const sameInput = anonymize({ text: "hello" }, { uploadId: "u2", ownerEmail: OWNER_EMAIL });
    expect(sameInput.contentHashHex).toBe(base.contentHashHex);
    // Different input → different hash.
    const otherInput = anonymize({ text: "world" }, { uploadId: "u", ownerEmail: OWNER_EMAIL });
    expect(otherInput.contentHashHex).not.toBe(base.contentHashHex);
    // Same input, bumped policy version → different hash (forces re-upload).
    const newPolicy = anonymize(
      { text: "hello" },
      { uploadId: "u", ownerEmail: OWNER_EMAIL, policyVersion: `${POLICY_VERSION}-next` },
    );
    expect(newPolicy.contentHashHex).not.toBe(base.contentHashHex);
  });

  it("uses stable pseudonyms within a single invocation", () => {
    const home = "/Users/alice";
    const fixture = {
      sessions: [
        { text: `${home}/.claude/projects/acme/a.ts` },
        { text: `${home}/.claude/projects/acme/b.ts` },
      ],
    };
    const result = anonymize(fixture, {
      uploadId: "stable-test",
      ownerEmail: OWNER_EMAIL,
      homeDir: home,
    });
    const payload = result.payload as { sessions: Array<{ text: string }> };
    const a = payload.sessions[0]!.text;
    const b = payload.sessions[1]!.text;
    const projInA = a.match(PROJ_RE)?.[0];
    const projInB = b.match(PROJ_RE)?.[0];
    expect(projInA).toBeDefined();
    expect(projInA).toBe(projInB);
  });

  it("yields different pseudonyms across different uploadIds", () => {
    const home = "/Users/alice";
    const text = `${home}/.claude/projects/sameproject/main.ts`;
    const r1 = anonymize({ text }, { uploadId: "u-one", ownerEmail: OWNER_EMAIL, homeDir: home });
    const r2 = anonymize({ text }, { uploadId: "u-two", ownerEmail: OWNER_EMAIL, homeDir: home });
    const p1 = (r1.payload as { text: string }).text;
    const p2 = (r2.payload as { text: string }).text;
    const proj1 = p1.match(PROJ_RE)?.[0];
    const proj2 = p2.match(PROJ_RE)?.[0];
    expect(proj1).toBeDefined();
    expect(proj2).toBeDefined();
    expect(proj1).not.toBe(proj2);
  });

  it("PseudonymTable returns the same value for the same input", () => {
    const table = new PseudonymTable("upload-x");
    const a = table.pseudonymize("project-name", "acme");
    const b = table.pseudonymize("project-name", "acme");
    expect(a).toBe(b);
  });

  it("redacts home prefix in Cursor, Codex, and Gemini session paths", () => {
    const home = "/Users/bob";
    const fixture = {
      messages: [
        { text: `file at ${home}/.cursor/projects/my-project/src/main.ts` },
        { text: `session log ${home}/.codex/sessions/2026/05/25/abc.jsonl` },
        { text: `gemini log ${home}/.gemini/tmp/sess-xyz/logs.json` },
      ],
    };
    const result = anonymize(fixture, {
      uploadId: "u-multi",
      ownerEmail: OWNER_EMAIL,
      homeDir: home,
    });
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain(home);
    expect(serialized).toContain("<HOME>");
    expect(result.redactionsByCategory["home-path"]).toBeGreaterThanOrEqual(3);
  });
});

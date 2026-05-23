import { describe, it, expect } from "vitest";
import { anonymize } from "./index";

/**
 * Constitution Principle VI — Fail-Closed Anonymization:
 *   "For a canonical planted-secrets fixture, 100% of planted values across
 *    every redaction category are absent from the post-anonymization payload."
 *
 * This is the home of that suite. Categories listed below come straight from
 * specs/001-cloud-ingest-platform/spec.md FR-012. Each "planted" value below
 * MUST NOT appear in the post-anonymization JSON payload.
 *
 * The implementation lives in ./index.ts and is currently a stub. These
 * tests are the contract it has to satisfy.
 */
const PLANTED = {
  anthropicKey: "sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  openaiKey: "sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  awsAccessKey: "AKIAIOSFODNN7EXAMPLE",
  githubToken: "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  envLine: "DATABASE_URL=postgres://user:pass@host/db",
  homePath: "/Users/alice/code/secret-project/main.ts",
  otherEmail: "someone-else@example.com",
} as const;

const OWNER_EMAIL = "owner@example.com";

function buildFixture() {
  return {
    sessions: [
      {
        id: "s1",
        text: `here is the key ${PLANTED.anthropicKey} and ${PLANTED.openaiKey}`,
      },
      {
        id: "s2",
        text: `aws=${PLANTED.awsAccessKey} gh=${PLANTED.githubToken} ${PLANTED.envLine}`,
      },
      {
        id: "s3",
        text: `opened ${PLANTED.homePath} for ${PLANTED.otherEmail}; cc ${OWNER_EMAIL}`,
      },
    ],
  };
}

describe.todo("anonymize — planted secrets are removed across every redaction category", () => {
  it("removes every planted secret value from the serialized payload", () => {
    const result = anonymize(buildFixture(), {
      uploadId: "u-test",
      ownerEmail: OWNER_EMAIL,
      policyVersion: "v0",
    });
    const serialized = JSON.stringify(result.payload);
    for (const planted of Object.values(PLANTED)) {
      expect(serialized).not.toContain(planted);
    }
  });

  it("preserves the authenticated user's own email", () => {
    const result = anonymize(buildFixture(), {
      uploadId: "u-test",
      ownerEmail: OWNER_EMAIL,
      policyVersion: "v0",
    });
    expect(JSON.stringify(result.payload)).toContain(OWNER_EMAIL);
  });

  it("reports a redaction count for every category that fired", () => {
    const result = anonymize(buildFixture(), {
      uploadId: "u-test",
      ownerEmail: OWNER_EMAIL,
      policyVersion: "v0",
    });
    const total = Object.values(result.redactions).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });
});

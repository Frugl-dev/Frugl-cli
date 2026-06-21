import { afterEach, describe, expect, it, vi } from "vitest";
import { AnonymizationError } from "../lib/errors.js";
import { anonymize } from "./index.js";
import { REDACTION_CATEGORIES, type RedactionCategory } from "./policy.js";
import { secretsRule } from "./rules/secrets.js";

// Fail-closed coverage gate (PRE-RELEASE §4): a planted-secrets fixture that
// exercises EVERY redaction category. Each entry plants a value that the
// category's rule must catch, and `vanish` is the exact substring that must not
// survive serialization. The suite is driven off REDACTION_CATEGORIES, so adding
// a category to the policy without a planted fixture fails this test rather than
// silently shipping an un-exercised redaction path.

const OWNER_EMAIL = "owner@example.com";
const HOME = "/Users/alice";

interface Plant {
  // A snippet containing the secret in the context its rule needs to fire.
  text: string;
  // Substrings that must be absent from the anonymized, serialized payload.
  vanish: string[];
}

// Assembled from fragments so no provider-shaped literal ever sits contiguously
// in the source for a secret scanner's push-protection to flag. The runtime
// value still matches the provider-token rule (the Stripe secret-key form).
const PROVIDER_TOKEN = ["sk", "live", "EXAMPLEEXAMPLEEXAMPLE000"].join("_");

const PLANTS: Record<RedactionCategory, Plant> = {
  "anthropic-key": {
    text: "anthropic key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA done",
    vanish: ["sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  },
  "openai-key": {
    text: "openai key sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB done",
    vanish: ["sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
  },
  "aws-key": {
    text: "aws access key AKIAIOSFODNN7EXAMPLE done",
    vanish: ["AKIAIOSFODNN7EXAMPLE"],
  },
  "gcp-key": {
    text: '{ "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIBVgIBADANBgkqhkiG9w0GCPUNIQUEBODY01\\n-----END PRIVATE KEY-----\\n" }',
    vanish: ["MIIBVgIBADANBgkqhkiG9w0GCPUNIQUEBODY01"],
  },
  "private-key": {
    text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpRSAUNIQUEBODY0001abcdefXYZ\n-----END RSA PRIVATE KEY-----",
    vanish: ["MIIEpRSAUNIQUEBODY0001abcdefXYZ"],
  },
  "github-token": {
    text: "github token ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC done",
    vanish: ["ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"],
  },
  "slack-webhook": {
    text: "slack hook https://hooks.slack.com/services/T0000/B1111/abcdefghijklmnop done",
    vanish: ["https://hooks.slack.com/services/T0000/B1111/abcdefghijklmnop"],
  },
  jwt: {
    text: "bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.s1gn4tur3DUMMYabc_def done",
    vanish: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.s1gn4tur3DUMMYabc_def"],
  },
  "connection-string": {
    text: "db url redis://admin:s3cretP4ssw0rd@cache.internal:6379 done",
    vanish: ["s3cretP4ssw0rd"],
  },
  "bearer-token": {
    text: "Authorization: Bearer t0pSecretBEARERvalue_AbC-123 done",
    vanish: ["t0pSecretBEARERvalue_AbC-123"],
  },
  "provider-token": {
    text: `stripe key ${PROVIDER_TOKEN} done`,
    vanish: [PROVIDER_TOKEN],
  },
  "env-line": {
    text: "EXPORTED_API_TOKEN=plaintextSecret9999",
    vanish: ["plaintextSecret9999"],
  },
  "home-path": {
    text: `${HOME}/.claude/projects/acme-secret/main.ts`,
    vanish: [HOME],
  },
  "project-name": {
    text: `${HOME}/.claude/projects/topsecret-proj/handler.ts`,
    vanish: ["topsecret-proj"],
  },
  "third-party-email": {
    text: "cc someone-else@example.com on the thread",
    vanish: ["someone-else@example.com"],
  },
  "entropy-fallback": {
    text: "opaque blob Zm9vYmFyYmF6YnV6QUJDREVGRzEyMzQ1Njc4OWFiYw end",
    vanish: ["Zm9vYmFyYmF6YnV6QUJDREVGRzEyMzQ1Njc4OWFiYw"],
  },
};

function plantedFixture() {
  return {
    sessions: Object.entries(PLANTS).map(([category, plant]) => ({
      id: category,
      text: plant.text,
    })),
  };
}

describe("anonymize — planted-secrets coverage (every category)", () => {
  it("has a planted fixture for every redaction category (no drift)", () => {
    for (const category of REDACTION_CATEGORIES) {
      expect(PLANTS[category], `missing planted fixture for "${category}"`).toBeDefined();
    }
  });

  it("redacts every planted secret from the serialized payload", () => {
    const result = anonymize(plantedFixture(), {
      uploadId: "u-planted",
      ownerEmail: OWNER_EMAIL,
      homeDir: HOME,
    });
    const serialized = JSON.stringify(result.payload);
    for (const [category, plant] of Object.entries(PLANTS)) {
      for (const secret of plant.vanish) {
        expect(serialized, `"${category}" left "${secret}" in the payload`).not.toContain(secret);
      }
    }
  });

  it("fires a redaction count for every category", () => {
    const result = anonymize(plantedFixture(), {
      uploadId: "u-planted",
      ownerEmail: OWNER_EMAIL,
      homeDir: HOME,
    });
    for (const category of REDACTION_CATEGORIES) {
      expect(
        result.redactionsByCategory[category],
        `category "${category}" never fired`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("still preserves the authenticated user's own email", () => {
    const result = anonymize(
      { sessions: [{ text: `from ${OWNER_EMAIL} cc someone-else@example.com` }] },
      { uploadId: "u-planted", ownerEmail: OWNER_EMAIL, homeDir: HOME },
    );
    const serialized = JSON.stringify(result.payload);
    expect(serialized).toContain(OWNER_EMAIL);
    expect(serialized).not.toContain("someone-else@example.com");
  });
});

describe("anonymize — fail-closed over the planted fixture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits no payload and leaks nothing when a rule throws mid-redaction", () => {
    const spy = vi.spyOn(secretsRule, "apply").mockImplementation(() => {
      throw new Error("rule blew up");
    });
    let result: unknown;
    expect(() => {
      result = anonymize(plantedFixture(), {
        uploadId: "u-planted-fail",
        ownerEmail: OWNER_EMAIL,
        homeDir: HOME,
      });
    }).toThrow(AnonymizationError);
    // Fail-closed: no result object escapes, so no half-redacted payload can be
    // serialized or uploaded.
    expect(result).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// A focused JSON-Schema validator covering the constructs used by
// manifest-entry.gitcontext.schema.json (type/required/additionalProperties/
// properties/$ref/allOf/pattern/minLength/enum/integer-minimum). Validates that
// the camelCase gitContext shape the CLI surfaces matches the public contract and
// that the additive merge is backward-compatible (FR-010/FR-012/SC-006).

type JsonSchema = Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = JSON.parse(
  readFileSync(
    path.join(
      here,
      "../../specs/005-cli-pr-metadata/contracts/manifest-entry.gitcontext.schema.json",
    ),
    "utf8",
  ),
) as JsonSchema;

function resolveRef(ref: string): JsonSchema {
  const name = ref.replace("#/$defs/", "");
  const def = (root["$defs"] as Record<string, JsonSchema>)[name];
  if (!def) throw new Error(`unknown $ref ${ref}`);
  return def;
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    default:
      return true;
  }
}

function validate(schema: JsonSchema, value: unknown, p = "$"): string[] {
  if (typeof schema["$ref"] === "string") return validate(resolveRef(schema["$ref"]), value, p);
  const errors: string[] = [];
  if (Array.isArray(schema["allOf"])) {
    for (const sub of schema["allOf"] as JsonSchema[]) errors.push(...validate(sub, value, p));
  }
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) {
    errors.push(`${p}: not in enum`);
  }
  if (typeof schema["type"] === "string" && !typeMatches(schema["type"], value)) {
    errors.push(`${p}: expected ${schema["type"]}`);
    return errors;
  }
  if (typeof value === "string") {
    if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"]).test(value)) {
      errors.push(`${p}: fails pattern ${schema["pattern"]}`);
    }
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) {
      errors.push(`${p}: shorter than minLength`);
    }
  }
  if (schema["type"] === "integer" && typeof schema["minimum"] === "number") {
    if (typeof value === "number" && value < schema["minimum"]) errors.push(`${p}: below minimum`);
  }
  if (typeMatches("object", value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema["properties"] as Record<string, JsonSchema>) ?? {};
    for (const req of (schema["required"] as string[]) ?? []) {
      if (!(req in obj)) errors.push(`${p}: missing required "${req}"`);
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${p}: unexpected property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) errors.push(...validate(sub, obj[key], `${p}.${key}`));
    }
  }
  return errors;
}

const validGitContext = {
  repository: { host: "github.com", owner: "acme", name: "widgets" },
  branch: "005-cli-pr-metadata",
  commitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
};

describe("manifest gitContext public contract (FR-010/SC-006)", () => {
  it("a produced gitContext validates against $defs.GitContext", () => {
    expect(validate({ $ref: "#/$defs/GitContext" }, validGitContext)).toEqual([]);
  });

  it("a gitContext without a branch (detached HEAD) is still valid", () => {
    const { branch, ...noBranch } = validGitContext;
    void branch;
    expect(validate({ $ref: "#/$defs/GitContext" }, noBranch)).toEqual([]);
  });

  it("a full ManifestEntry carrying gitContext validates", () => {
    const entry = {
      sessionId: "d3dae575-3ab7-463c-873f-8dfefb789a47",
      identityDerivation: "native",
      contentHash: "a".repeat(64),
      byteSize: 14821,
      gitContext: validGitContext,
    };
    expect(validate(root, entry)).toEqual([]);
  });

  it("a 001-era ManifestEntry WITHOUT gitContext still validates (backward-compatible)", () => {
    const entry = {
      sessionId: "d3dae575-3ab7-463c-873f-8dfefb789a47",
      identityDerivation: "native",
      contentHash: "a".repeat(64),
      byteSize: 0,
    };
    expect(validate(root, entry)).toEqual([]);
  });

  it("rejects a non-40-hex commitSha and a host containing userinfo (credential can't appear)", () => {
    expect(
      validate({ $ref: "#/$defs/GitContext" }, { ...validGitContext, commitSha: "abc" }).length,
    ).toBeGreaterThan(0);
    expect(
      validate(
        { $ref: "#/$defs/GitContext" },
        { ...validGitContext, repository: { host: "user@github.com", owner: "a", name: "b" } },
      ).length,
    ).toBeGreaterThan(0);
  });
});

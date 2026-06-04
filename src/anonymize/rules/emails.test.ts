import { describe, it, expect } from "vitest";
import { PseudonymTable } from "../pseudonyms.js";
import { emailsRule } from "./emails.js";
import type { RuleContext } from "./types.js";

const OWNER = "owner@example.com";

function makeCtx(): RuleContext {
  return {
    pseudonyms: new PseudonymTable("u-emails"),
    ownerEmail: OWNER,
  };
}

describe("emailsRule", () => {
  it("has the expected id and categories", () => {
    expect(emailsRule.id).toBe("emails");
    expect(emailsRule.categories).toEqual(["third-party-email"]);
  });

  it("pseudonymizes a third-party email and counts it", () => {
    const planted = "someone-else@example.com";
    const { output, counts } = emailsRule.apply(`cc ${planted} please`, makeCtx());
    expect(output).not.toContain(planted);
    expect(output).toMatch(/user_[a-f0-9]+/);
    expect(counts["third-party-email"]).toBe(1);
  });

  it("preserves the owner email", () => {
    const { output, counts } = emailsRule.apply(`from ${OWNER} to nobody`, makeCtx());
    expect(output).toContain(OWNER);
    expect(counts["third-party-email"]).toBeUndefined();
  });

  it("preserves the owner email case-insensitively", () => {
    const { output, counts } = emailsRule.apply("from OWNER@Example.com hi", makeCtx());
    expect(output).toContain("OWNER@Example.com");
    expect(Object.keys(counts)).toHaveLength(0);
  });

  it("is a no-op on benign input", () => {
    const benign = "no addresses here, just words";
    const { output, counts } = emailsRule.apply(benign, makeCtx());
    expect(output).toBe(benign);
    expect(Object.keys(counts)).toHaveLength(0);
  });
});

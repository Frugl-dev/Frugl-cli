import { describe, expect, it } from "vitest";
import { EXIT } from "./exit-codes.js";

describe("EXIT", () => {
  // These codes are a public contract: scripts, the e2e suite, and CI gates
  // branch on them, so changing a value is a breaking change. This locks them.
  it("pins the documented exit codes", () => {
    expect(EXIT).toEqual({
      OK: 0,
      GENERIC_FAILURE: 1,
      USAGE: 2,
      AUTH_FAILURE: 10,
      KEYCHAIN_UNAVAILABLE: 11,
      NO_SESSIONS_FOUND: 20,
      ANONYMIZATION_FAILURE: 30,
      NETWORK_FAILURE: 40,
      ENDPOINT_UNREACHABLE: 41,
      VERSION_GATE_FAILURE: 50,
    });
  });

  it("assigns a unique code to every outcome", () => {
    const codes = Object.values(EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

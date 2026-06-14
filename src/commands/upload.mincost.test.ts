import { describe, it, expect } from "vitest";
import { parseCostFlag, MIN_COST_FLOOR_USD } from "./upload.js";
import { UsageError } from "../lib/errors.js";

describe("parseCostFlag", () => {
  it("accepts the floor and values above it", () => {
    expect(parseCostFlag("10", "--min-cost")).toBe(10);
    expect(parseCostFlag("10.00", "--min-cost")).toBe(10);
    expect(parseCostFlag("25", "--min-cost")).toBe(25);
  });

  it("rejects values below the $10 floor (incl. 0)", () => {
    for (const raw of ["0", "0.01", "1", "9.99"]) {
      expect(() => parseCostFlag(raw, "--min-cost")).toThrow(UsageError);
      expect(() => parseCostFlag(raw, "--min-cost")).toThrow(
        `--min-cost must be at least $${MIN_COST_FLOOR_USD.toFixed(2)}`,
      );
    }
  });

  it("rejects non-numeric and negative input", () => {
    expect(() => parseCostFlag("abc", "--min-cost")).toThrow(UsageError);
    expect(() => parseCostFlag("-5", "--min-cost")).toThrow(UsageError);
  });

  it("returns undefined when the flag is absent", () => {
    expect(parseCostFlag(undefined, "--min-cost")).toBeUndefined();
  });
});

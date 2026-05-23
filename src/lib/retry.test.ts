import { describe, it, expect } from "vitest";
import { shouldRetry, withRetry } from "./retry.js";

describe("shouldRetry", () => {
  it("retries on network errors (no status)", () => {
    expect(shouldRetry(new Error("ECONNRESET"))).toBe(true);
  });

  it("retries on HTTP 500/502/503/504", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(shouldRetry({ status })).toBe(true);
    }
  });

  it("retries on HTTP 429", () => {
    expect(shouldRetry({ status: 429 })).toBe(true);
  });

  it("does NOT retry on HTTP 401", () => {
    expect(shouldRetry({ status: 401 })).toBe(false);
  });

  it("does NOT retry on HTTP 403", () => {
    expect(shouldRetry({ status: 403 })).toBe(false);
  });

  it("does NOT retry on HTTP 426 (version gate)", () => {
    expect(shouldRetry({ status: 426 })).toBe(false);
  });

  it("does NOT retry on other 4xx (400, 404, 409)", () => {
    for (const status of [400, 404, 409, 410]) {
      expect(shouldRetry({ status })).toBe(false);
    }
  });
});

describe("withRetry", () => {
  it("succeeds on the first attempt", async () => {
    let count = 0;
    const result = await withRetry(async () => {
      count++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(count).toBe(1);
  });

  it("retries up to 3 attempts on transient errors", async () => {
    let count = 0;
    const result = await withRetry(
      async () => {
        count++;
        if (count < 3) {
          const err = Object.assign(new Error("transient"), { status: 500 });
          throw err;
        }
        return "ok";
      },
      { baseMs: 1, maxMs: 5 },
    );
    expect(result).toBe("ok");
    expect(count).toBe(3);
  });

  it("aborts immediately on non-retryable status", async () => {
    let count = 0;
    await expect(
      withRetry(
        async () => {
          count++;
          const err = Object.assign(new Error("auth"), { status: 401 });
          throw err;
        },
        { baseMs: 1, maxMs: 5 },
      ),
    ).rejects.toThrow(/auth/);
    expect(count).toBe(1);
  });
});

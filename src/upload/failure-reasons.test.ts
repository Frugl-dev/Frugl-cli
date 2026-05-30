import { describe, it, expect } from "vitest";
import { classifyFailure, FAILURE_REASON_INFO, FAILURE_REASONS } from "./failure-reasons.js";
import { AnonymizationError, NetworkError } from "../lib/errors.js";
import { CloudHttpError } from "../cloud/client.js";

describe("classifyFailure", () => {
  it("maps HTTP 409 to conflict", () => {
    const err = new CloudHttpError(409, { error: "already_uploaded" }, "conflict");
    expect(classifyFailure(err)).toEqual({ reason: "conflict", message: "HTTP 409" });
  });

  it("maps HTTP 403 to presign-expired", () => {
    const err = new CloudHttpError(403, "", "forbidden");
    expect(classifyFailure(err)).toEqual({ reason: "presign-expired", message: "HTTP 403" });
  });

  it("maps 5xx to network with the status in the message", () => {
    const err = new CloudHttpError(503, "", "unavailable");
    expect(classifyFailure(err)).toEqual({ reason: "network", message: "HTTP 503" });
  });

  it("maps AnonymizationError to anonymization", () => {
    expect(classifyFailure(new AnonymizationError("rule threw")).reason).toBe("anonymization");
  });

  it("maps a JSON SyntaxError to parse", () => {
    let caught: unknown;
    try {
      JSON.parse("{bad");
    } catch (e) {
      caught = e;
    }
    expect(classifyFailure(caught).reason).toBe("parse");
  });

  it("maps a NetworkError without status to network", () => {
    expect(classifyFailure(new NetworkError("connection reset")).reason).toBe("network");
  });

  it("falls back to unknown for a non-error value", () => {
    expect(classifyFailure("nope")).toEqual({ reason: "unknown" });
  });

  it("every reason has remedy metadata with a unique order", () => {
    const orders = new Set<number>();
    for (const reason of FAILURE_REASONS) {
      const info = FAILURE_REASON_INFO[reason];
      expect(info.summary.length).toBeGreaterThan(0);
      expect(info.remedy.length).toBeGreaterThan(0);
      orders.add(info.order);
    }
    expect(orders.size).toBe(FAILURE_REASONS.length);
  });
});

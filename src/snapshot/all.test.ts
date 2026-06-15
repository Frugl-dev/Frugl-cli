import { describe, it, expect, vi, afterEach } from "vitest";
import { runAllSnapshots, type SnapshotStep } from "./all.js";
import type { SnapshotRunContext } from "./shared.js";
import { FruglError, NetworkError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";

// The steps are injected, so the run context only needs its output mode.
const ctx = { mode: "default" } as unknown as SnapshotRunContext;

const failContext: SnapshotStep = async () => {
  throw new FruglError("context boom", EXIT.GENERIC_FAILURE);
};
const failNetwork: SnapshotStep = async () => {
  throw new NetworkError("net down"); // EXIT.NETWORK_FAILURE
};
const failGeneric: SnapshotStep = async () => {
  throw new FruglError("later boom", EXIT.GENERIC_FAILURE);
};
const throwBug: SnapshotStep = async () => {
  throw new TypeError("bug");
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAllSnapshots", () => {
  it("runs every step in order and exits 0 when all succeed", async () => {
    const order: string[] = [];
    const stepA: SnapshotStep = async () => {
      order.push("context");
    };
    const stepB: SnapshotStep = async () => {
      order.push("mcp");
    };

    const code = await runAllSnapshots(ctx, [stepA, stepB]);
    expect(code).toBe(0);
    expect(order).toEqual(["context", "mcp"]);
  });

  it("reports a failed step but still runs the rest (a failure never blocks the other)", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const ran: string[] = [];
    const ok: SnapshotStep = async () => {
      ran.push("mcp");
    };

    const code = await runAllSnapshots(ctx, [failContext, ok]);
    // The mcp step still ran despite the context step failing.
    expect(ran).toEqual(["mcp"]);
    // Exit code is the failure's code.
    expect(code).toBe(EXIT.GENERIC_FAILURE);
  });

  it("returns the FIRST failure's exit code when more than one step fails", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await runAllSnapshots(ctx, [failNetwork, failGeneric]);
    expect(code).toBe(EXIT.NETWORK_FAILURE);
  });

  it("propagates an unexpected (non-Frugl) error instead of swallowing it", async () => {
    await expect(runAllSnapshots(ctx, [throwBug])).rejects.toThrow(TypeError);
  });
});

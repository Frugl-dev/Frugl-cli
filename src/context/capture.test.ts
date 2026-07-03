import { describe, it, expect } from "vitest";
import { captureContext } from "./capture.js";
import type { Spawner, SpawnResult } from "./tools/claude-code.js";
import { FruglError } from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";

const SAMPLE = "## Context Usage\n\n**Tokens:** 21.9k / 1m (2%)\n";

function ok(stdout: string): Spawner {
  return () => ({ status: 0, stdout, stderr: "" });
}

function spawnResult(overrides: Partial<SpawnResult>): Spawner {
  return () => ({ status: 0, stdout: "", stderr: "", ...overrides });
}

// Capture the thrown error without conditional `expect`s (oxlint:
// vitest/no-conditional-expect). Fails the assertion if nothing was thrown.
function caught(fn: () => unknown): FruglError {
  let error: unknown;
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    error = err;
  }
  expect(threw).toBe(true);
  expect(error).toBeInstanceOf(FruglError);
  return error as FruglError;
}

describe("captureContext", () => {
  it("captures claude-code stdout verbatim and stamps capturedAt", () => {
    const capture = captureContext("claude-code", {
      spawner: ok(SAMPLE),
      now: () => "2026-06-06T09:00:00.000Z",
    });
    expect(capture.tool).toBe("claude-code");
    expect(capture.text).toBe(SAMPLE);
    expect(capture.capturedAt).toBe("2026-06-06T09:00:00.000Z");
  });

  it("passes `claude -p /context` to the spawner", () => {
    let seen: { cmd: string; args: string[] } | undefined;
    const spy: Spawner = (cmd, args) => {
      seen = { cmd, args };
      return { status: 0, stdout: SAMPLE, stderr: "" };
    };
    captureContext("claude-code", { spawner: spy });
    expect(seen).toEqual({ cmd: "claude", args: ["-p", "/context"] });
  });

  it("fails closed for an unsupported tool (no spawn, clear named error)", () => {
    let spawned = false;
    const spy: Spawner = () => {
      spawned = true;
      return { status: 0, stdout: SAMPLE, stderr: "" };
    };
    const err = caught(() => captureContext("windsurf", { spawner: spy }));
    expect(err.message).toContain("windsurf");
    expect(err.exitCode).not.toBe(EXIT.OK);
    expect(spawned).toBe(false);
  });

  it("fails closed when the claude binary is missing (ENOENT)", () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    expect(() =>
      captureContext("claude-code", { spawner: spawnResult({ error: enoent }) }),
    ).toThrow(/not found on your PATH/);
  });

  it("fails closed on a non-zero subprocess exit (includes stderr snippet)", () => {
    const spawn = spawnResult({ status: 2, stderr: "boom: something went wrong" });
    const err = caught(() => captureContext("claude-code", { spawner: spawn }));
    expect(err.message).toContain("exited with code 2");
    expect(err.message).toContain("boom: something went wrong");
  });

  it("fails closed on empty / whitespace-only stdout", () => {
    expect(() => captureContext("claude-code", { spawner: ok("   \n  \t ") })).toThrow(/no output/);
  });

  // US4 / T030: two captures with distinct timestamps produce two distinct
  // payloads — no overwrite/dedupe semantics. The timestamp is fresh each run.
  it("produces distinct captures across runs (distinct captured_at)", () => {
    const a = captureContext("claude-code", {
      spawner: ok(SAMPLE),
      now: () => "2026-06-06T09:00:00.000Z",
    });
    const b = captureContext("claude-code", {
      spawner: ok(SAMPLE),
      now: () => "2026-06-06T10:00:00.000Z",
    });
    expect(a.capturedAt).not.toBe(b.capturedAt);
    expect(a).not.toEqual(b);
  });

  // US4 / T030: a failed invocation leaves no state that blocks the next run —
  // capture is pure dispatch, so a success right after a failure just works.
  it("a failed run does not block a subsequent successful run", () => {
    expect(() => captureContext("claude-code", { spawner: spawnResult({ status: 1 }) })).toThrow(
      FruglError,
    );

    const after = captureContext("claude-code", {
      spawner: ok(SAMPLE),
      now: () => "2026-06-06T11:00:00.000Z",
    });
    expect(after.text).toBe(SAMPLE);
    expect(after.capturedAt).toBe("2026-06-06T11:00:00.000Z");
  });
});

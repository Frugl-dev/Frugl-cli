import { describe, it, expect } from "vitest";
import { captureClaudeCodeContext, type SpawnResult, type Spawner } from "./claude-code.js";
import { FruglError } from "../../lib/errors.js";
import { EXIT } from "../../lib/exit-codes.js";

// A spawner that returns a fixed result; defaults model a clean success.
function spawnerOf(overrides: Partial<SpawnResult>): Spawner {
  return () => ({
    status: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  });
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

describe("captureClaudeCodeContext", () => {
  it("returns stdout verbatim on a clean success", () => {
    const captured: { cmd: string; args: string[] } = { cmd: "", args: [] };
    const spawner: Spawner = (cmd, args) => {
      captured.cmd = cmd;
      captured.args = args;
      return { status: 0, stdout: "## Context Usage\n  raw  output  ", stderr: "" };
    };

    const out = captureClaudeCodeContext(spawner);

    // Verbatim — including surrounding whitespace, not trimmed.
    expect(out).toBe("## Context Usage\n  raw  output  ");
    // Invokes the documented command.
    expect(captured.cmd).toBe("claude");
    expect(captured.args).toEqual(["-p", "/context"]);
  });

  it("throws an instructive FruglError when the binary is missing (ENOENT)", () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const err = caught(() => captureClaudeCodeContext(spawnerOf({ error: enoent })));
    expect(err.exitCode).toBe(EXIT.GENERIC_FAILURE);
    expect(err.message).toContain("not found on your PATH");
  });

  it("throws a launch-failure FruglError for a non-ENOENT spawn error", () => {
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const err = caught(() => captureClaudeCodeContext(spawnerOf({ error: eacces })));
    expect(err.message).toContain("Failed to launch 'claude': permission denied");
  });

  it("fails closed on a non-zero exit and includes the stderr snippet", () => {
    const err = caught(() =>
      captureClaudeCodeContext(spawnerOf({ status: 2, stderr: "  boom on stderr  " })),
    );
    expect(err.exitCode).toBe(EXIT.GENERIC_FAILURE);
    expect(err.message).toContain("exited with code 2");
    expect(err.message).toContain("stderr: boom on stderr");
  });

  it("reports 'unknown' for a null exit status", () => {
    const err = caught(() => captureClaudeCodeContext(spawnerOf({ status: null, stderr: "" })));
    expect(err.message).toContain("exited with code unknown");
  });

  it("omits the stderr clause when stderr is empty on a non-zero exit", () => {
    const err = caught(() => captureClaudeCodeContext(spawnerOf({ status: 1, stderr: "   " })));
    expect(err.message).not.toContain("stderr:");
  });

  it("truncates a very long stderr snippet to 500 chars", () => {
    const long = "x".repeat(1000);
    const err = caught(() => captureClaudeCodeContext(spawnerOf({ status: 1, stderr: long })));
    const after = err.message.split("stderr: ")[1] ?? "";
    expect(after).toHaveLength(500);
  });

  it("throws on empty/whitespace-only stdout (no fabricated snapshot)", () => {
    const err = caught(() => captureClaudeCodeContext(spawnerOf({ status: 0, stdout: "   \n  " })));
    expect(err.exitCode).toBe(EXIT.GENERIC_FAILURE);
    expect(err.message).toContain("produced no output");
  });
});

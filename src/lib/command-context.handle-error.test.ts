import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudHttpError } from "../cloud/client.js";
import { handleCommandError } from "./command-context.js";
import {
  AnonymizationError,
  AuthError,
  EndpointError,
  FruglError,
  KeychainError,
  NetworkError,
  NoSessionsError,
  UsageError,
  VersionGateError,
} from "./errors.js";
import { EXIT } from "./exit-codes.js";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string): string => s.replace(ANSI_RE, "");

let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  stderr = "";
  exitCode = undefined;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  // handleCommandError calls process.exit(code) with a `never` return. Trap it
  // so the test can read the code without tearing down the process.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit__:${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Drive handleCommandError, catching the thrown exit sentinel so the test can
// inspect the captured exit code + stderr.
function run(
  err: unknown,
  mode: "default" | "json",
): { exitCode: number | undefined; out: string } {
  try {
    handleCommandError(err, mode);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e;
  }
  return { exitCode, out: plain(stderr) };
}

describe("handleCommandError — frozen exit-code contract (FR-037)", () => {
  // Each FruglError subclass must exit with its EXIT.* code. This proves the
  // dispatch once for every subclass instead of once per command.
  const cases: Array<[FruglError, number]> = [
    [new AuthError("x"), EXIT.AUTH_FAILURE],
    [new KeychainError("x"), EXIT.KEYCHAIN_UNAVAILABLE],
    [new NoSessionsError("x"), EXIT.NO_SESSIONS_FOUND],
    [new AnonymizationError("x"), EXIT.ANONYMIZATION_FAILURE],
    [new NetworkError("x"), EXIT.NETWORK_FAILURE],
    [new EndpointError("x"), EXIT.ENDPOINT_UNREACHABLE],
    [new VersionGateError("1.0.0", "2.0.0"), EXIT.VERSION_GATE_FAILURE],
    [new UsageError("x"), EXIT.USAGE],
    [new FruglError("x", EXIT.GENERIC_FAILURE), EXIT.GENERIC_FAILURE],
  ];

  it.each(cases)("%o exits with its declared code", (err, code) => {
    expect(run(err, "default").exitCode).toBe(code);
  });

  it("CloudHttpError exits GENERIC_FAILURE (1)", () => {
    const { exitCode: code } = run(new CloudHttpError(500, {}, "boom"), "default");
    expect(code).toBe(EXIT.GENERIC_FAILURE);
  });

  it("an arbitrary Error is NOT swallowed — it propagates to oclif", () => {
    const arbitrary = new Error("plain error");
    expect(() => handleCommandError(arbitrary, "default")).toThrow(arbitrary);
    expect(exitCode).toBeUndefined();
  });

  it("a non-Error value also propagates", () => {
    expect(() => handleCommandError("just a string", "default")).toThrow("just a string");
    expect(exitCode).toBeUndefined();
  });
});

describe("handleCommandError — rendering parity with printFruglError", () => {
  it("text mode emits the `Exit code N (NAME)` footer", () => {
    const { out } = run(new AuthError("Not logged in."), "default");
    expect(out).toContain("frugl: Not logged in.");
    expect(out).toContain("Exit code 10  (AUTH_FAILURE)");
  });

  it("json mode omits the footer", () => {
    const { out } = run(new AuthError("Not logged in."), "json");
    expect(out).toContain("frugl: Not logged in.");
    expect(out).not.toContain("Exit code");
  });

  it("CloudHttpError renders a generic `frugl:` line, no footer", () => {
    const { out } = run(new CloudHttpError(502, {}, "bad gateway"), "default");
    expect(out).toContain("frugl: bad gateway");
    expect(out).not.toContain("Exit code");
  });
});

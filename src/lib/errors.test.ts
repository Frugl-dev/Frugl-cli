import { describe, expect, it, vi } from "vitest";
import {
  AnonymizationError,
  AuthError,
  EndpointError,
  type FruglError,
  InspectDirError,
  KeychainError,
  NetworkError,
  NoSessionsError,
  UsageError,
  VersionGateError,
  exitCodeName,
  printFruglError,
} from "./errors.js";
import { EXIT } from "./exit-codes.js";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string): string => s.replace(ANSI_RE, "");

describe("exitCodeName", () => {
  it("maps stable codes back to their symbolic names", () => {
    expect(exitCodeName(EXIT.AUTH_FAILURE)).toBe("AUTH_FAILURE");
    expect(exitCodeName(EXIT.ANONYMIZATION_FAILURE)).toBe("ANONYMIZATION_FAILURE");
    expect(exitCodeName(999)).toBeUndefined();
  });
});

// FR-037 frozen contract guard, independent of any dispatch helper: pin the full
// EXIT map and assert every FruglError subclass carries its declared code so a
// regression in either the map or a subclass trips here.
describe("EXIT frozen contract (FR-037)", () => {
  it("pins the full code map", () => {
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
      INSPECT_DIR_EXISTS: 60,
    });
  });

  const subclasses: Array<[FruglError, number]> = [
    [new AuthError("x"), EXIT.AUTH_FAILURE],
    [new KeychainError("x"), EXIT.KEYCHAIN_UNAVAILABLE],
    [new NoSessionsError("x"), EXIT.NO_SESSIONS_FOUND],
    [new AnonymizationError("x"), EXIT.ANONYMIZATION_FAILURE],
    [new NetworkError("x"), EXIT.NETWORK_FAILURE],
    [new EndpointError("x"), EXIT.ENDPOINT_UNREACHABLE],
    [new VersionGateError("1.0.0", "2.0.0"), EXIT.VERSION_GATE_FAILURE],
    [new InspectDirError("x"), EXIT.INSPECT_DIR_EXISTS],
    [new UsageError("x"), EXIT.USAGE],
  ];

  it.each(subclasses)("%o carries its declared exit code", (err, code) => {
    expect(err.exitCode).toBe(code);
  });
});

describe("printFruglError", () => {
  it("writes the message + exit-code footer and returns the code (text mode)", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const code = printFruglError(
      new AuthError("Not logged in. Run 'frugl login' first."),
      "default",
    );
    spy.mockRestore();

    const out = plain(writes.join(""));
    expect(code).toBe(EXIT.AUTH_FAILURE);
    expect(out).toContain("frugl: Not logged in.");
    expect(out).toContain("Exit code 10  (AUTH_FAILURE)");
  });

  it("omits the exit-code footer in json mode", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    printFruglError(new AuthError("nope"), "json");
    spy.mockRestore();

    const out = plain(writes.join(""));
    expect(out).toContain("frugl: nope");
    expect(out).not.toContain("Exit code");
  });
});

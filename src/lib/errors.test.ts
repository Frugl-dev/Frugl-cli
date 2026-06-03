import { describe, expect, it, vi } from "vitest";
import { AuthError, exitCodeName, printFruglError } from "./errors.js";
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

describe("printFruglError", () => {
  it("writes the message + exit-code footer and returns the code (text mode)", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const code = printFruglError(new AuthError("Not logged in. Run 'frugl login' first."), "text");
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

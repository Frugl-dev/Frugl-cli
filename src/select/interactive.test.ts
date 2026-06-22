import { describe, expect, it } from "vitest";
import { isInteractive } from "./interactive.js";

describe("isInteractive", () => {
  it("is interactive on a TTY with no overriding flags", () => {
    expect(isInteractive({ isTTY: true })).toBe(true);
  });

  it("is not interactive without a TTY", () => {
    expect(isInteractive({ isTTY: false })).toBe(false);
  });

  it("is not interactive for the json format even on a TTY", () => {
    expect(isInteractive({ mode: "json", isTTY: true })).toBe(false);
  });

  it("is not interactive for the minimal format even on a TTY", () => {
    expect(isInteractive({ mode: "minimal", isTTY: true })).toBe(false);
  });

  it("is interactive for the default format on a TTY", () => {
    expect(isInteractive({ mode: "default", isTTY: true })).toBe(true);
  });

  it("treats an undefined mode the same as default", () => {
    expect(isInteractive({ mode: undefined, isTTY: true })).toBe(true);
  });

  it("is not interactive when --yes is set even on a TTY", () => {
    expect(isInteractive({ yes: true, isTTY: true })).toBe(false);
  });

  it("--yes takes priority over a default mode", () => {
    expect(isInteractive({ mode: "default", yes: true, isTTY: true })).toBe(false);
  });

  it("a non-interactive mode short-circuits before the TTY check", () => {
    // Even with a TTY, json mode wins; and yes is irrelevant here.
    expect(isInteractive({ mode: "json", isTTY: true, yes: false })).toBe(false);
  });

  it("falls back to process.stdin.isTTY when isTTY is omitted", () => {
    const original = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      expect(isInteractive({})).toBe(true);
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      expect(isInteractive({})).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
    }
  });

  it("coerces an undefined process.stdin.isTTY to false", () => {
    const original = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
      expect(isInteractive({})).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
    }
  });
});

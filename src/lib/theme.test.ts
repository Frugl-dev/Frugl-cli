import { describe, expect, it } from "vitest";
import { bar, formatBytes } from "./theme.js";

// Strip ANSI (incl. the ESC byte) so assertions hold whether or not color is on.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string): string => s.replace(ANSI_RE, "");

describe("theme.bar", () => {
  it("fills the requested cells and pads the rest", () => {
    expect(plain(bar(4, 10))).toBe("████░░░░░░");
  });

  it("clamps overflow and underflow to the bar width", () => {
    expect(plain(bar(99, 5))).toBe("█████");
    expect(plain(bar(-3, 5))).toBe("░░░░░");
  });

  it("rounds fractional fills", () => {
    expect(plain(bar(2.6, 10))).toBe("███░░░░░░░");
  });
});

describe("theme.formatBytes", () => {
  it("formats bytes, KB, and MB like the design", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12698)).toBe("12.4 KB");
    expect(formatBytes(5_033_165)).toBe("4.8 MB");
  });
});

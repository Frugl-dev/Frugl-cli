import { describe, it, expect } from "vitest";
import { parseNdjson } from "./ndjson.js";

describe("parseNdjson", () => {
  it("parses one record per non-blank line", () => {
    const records = parseNdjson('{"a":1}\n{"b":2}\n');
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips blank and whitespace-only lines", () => {
    const records = parseNdjson('{"a":1}\n\n   \n{"b":2}');
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("tolerates CRLF line endings", () => {
    const records = parseNdjson('{"a":1}\r\n{"b":2}\r\n');
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("preserves a malformed line as { _raw } instead of dropping it", () => {
    const records = parseNdjson('{"a":1}\nnot json\n{"b":2}');
    expect(records).toEqual([{ a: 1 }, { _raw: "not json" }, { b: 2 }]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseNdjson("")).toEqual([]);
    expect(parseNdjson("\n\n")).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProjectPin, PROJECT_PIN_FILENAME } from "./project-pin.js";
import { EndpointError } from "../lib/errors.js";

function writePin(dir: string, contents: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, PROJECT_PIN_FILENAME), contents, "utf8");
}

describe("loadProjectPin — checked-in `.frugl.json` (self-host)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "frugl-pin-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined when no `.frugl.json` exists anywhere up the tree", () => {
    const deep = path.join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(loadProjectPin(deep)).toBeUndefined();
  });

  it("reads the endpoint from a `.frugl.json` at the start dir", () => {
    writePin(root, JSON.stringify({ endpoint: "https://frugl.internal" }));
    const pin = loadProjectPin(root);
    expect(pin?.endpoint).toBe("https://frugl.internal");
    expect(pin?.path).toBe(path.join(root, PROJECT_PIN_FILENAME));
  });

  it("walks UP from a nested cwd to find the repo-root pin", () => {
    writePin(root, JSON.stringify({ endpoint: "https://frugl.internal" }));
    const deep = path.join(root, "packages", "app", "src");
    mkdirSync(deep, { recursive: true });
    expect(loadProjectPin(deep)?.endpoint).toBe("https://frugl.internal");
  });

  it("treats a file with no `endpoint` key as no pin (not an error)", () => {
    writePin(root, JSON.stringify({ linkPrs: true }));
    expect(loadProjectPin(root)).toBeUndefined();
  });

  it("FAIL-CLOSED: throws on invalid JSON rather than ignoring it", () => {
    writePin(root, "{ not json");
    expect(() => loadProjectPin(root)).toThrow(EndpointError);
  });

  it("FAIL-CLOSED: throws when the file is a JSON array, not an object", () => {
    writePin(root, JSON.stringify(["https://frugl.internal"]));
    expect(() => loadProjectPin(root)).toThrow(EndpointError);
  });

  it("FAIL-CLOSED: throws when `endpoint` is present but not a non-empty string", () => {
    writePin(root, JSON.stringify({ endpoint: "" }));
    expect(() => loadProjectPin(root)).toThrow(EndpointError);
  });

  it("FAIL-CLOSED: throws on a malformed endpoint URL rather than degrading", () => {
    writePin(root, JSON.stringify({ endpoint: "not a url" }));
    expect(() => loadProjectPin(root)).toThrow(EndpointError);
  });

  it("FAIL-CLOSED: throws on a non-localhost http endpoint (https-only rule)", () => {
    writePin(root, JSON.stringify({ endpoint: "http://evil.example.com" }));
    expect(() => loadProjectPin(root)).toThrow(EndpointError);
  });

  it("normalizes a valid endpoint (trailing slash stripped)", () => {
    writePin(root, JSON.stringify({ endpoint: "https://frugl.internal/" }));
    expect(loadProjectPin(root)?.endpoint).toBe("https://frugl.internal");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfigPathPin, loadProjectPin, PROJECT_PIN_FILENAME } from "./project-pin.js";
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

describe("loadConfigPathPin — explicit FRUGL_CONFIG_PATH (local-debug pointer)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "frugl-cfg-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined when the env is unset or empty", () => {
    expect(loadConfigPathPin(undefined)).toBeUndefined();
    expect(loadConfigPathPin("")).toBeUndefined();
    expect(loadConfigPathPin("   ")).toBeUndefined();
  });

  it("reads the endpoint from the file the env points at (any name, not just .frugl.json)", () => {
    const file = path.join(root, "local.json");
    writeFileSync(file, JSON.stringify({ endpoint: "http://localhost:4321" }), "utf8");
    const pin = loadConfigPathPin(file);
    expect(pin?.endpoint).toBe("http://localhost:4321");
    expect(pin?.path).toBe(file);
  });

  it("FAIL-CLOSED: throws when the env points at a missing file", () => {
    expect(() => loadConfigPathPin(path.join(root, "nope.json"))).toThrow(EndpointError);
  });

  it("FAIL-CLOSED: throws on a malformed config file (does not fall through)", () => {
    const file = path.join(root, "bad.json");
    writeFileSync(file, "{ not json", "utf8");
    expect(() => loadConfigPathPin(file)).toThrow(EndpointError);
  });

  it("applies the same https/localhost rule as a checked-in pin", () => {
    const file = path.join(root, "prod.json");
    writeFileSync(file, JSON.stringify({ endpoint: "http://evil.example.com" }), "utf8");
    expect(() => loadConfigPathPin(file)).toThrow(EndpointError);
  });
});

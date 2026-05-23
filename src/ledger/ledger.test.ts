import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ledger, type LedgerEntry } from "./ledger.js";

const HEX64 = "a".repeat(64);

function makeEntry(sessionId: string, contentHash = HEX64): LedgerEntry {
  return {
    sessionId,
    contentHash,
    lastUploadedAt: new Date().toISOString(),
    manifestId: "m-test",
  };
}

describe("Ledger", () => {
  let tempHome: string;
  let prevHome: string | undefined;
  let prevAppData: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), "poppi-ledger-"));
    prevHome = process.env["XDG_DATA_HOME"];
    prevAppData = process.env["APPDATA"];
    process.env["XDG_DATA_HOME"] = tempHome;
    process.env["APPDATA"] = tempHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env["XDG_DATA_HOME"];
    else process.env["XDG_DATA_HOME"] = prevHome;
    if (prevAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = prevAppData;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("starts empty for a fresh (endpoint, user)", () => {
    const ledger = new Ledger({ endpointUrl: "https://a.test", userId: "u1" }, { cwd: tempHome });
    expect(ledger.read().entries).toEqual({});
  });

  it("CRUD: upsert, read, clear", () => {
    const ledger = new Ledger({ endpointUrl: "https://a.test", userId: "u2" }, { cwd: tempHome });
    ledger.upsertEntry(makeEntry("s1"));
    ledger.upsertEntry(makeEntry("s2"));
    expect(Object.keys(ledger.read().entries)).toEqual(["s1", "s2"]);
    ledger.clear();
    expect(ledger.read().entries).toEqual({});
  });

  it("schema-version mismatch is treated as ledger loss, not failure", () => {
    const ledger = new Ledger({ endpointUrl: "https://a.test", userId: "u3" }, { cwd: tempHome });
    ledger.upsertEntry(makeEntry("s1"));
    const filePath = ledger.path;

    const raw = JSON.parse(readFileSync(filePath, "utf8")) as { data: { schemaVersion: number } };
    raw.data.schemaVersion = 99;
    writeFileSync(filePath, JSON.stringify(raw));

    const fresh = new Ledger({ endpointUrl: "https://a.test", userId: "u3" }, { cwd: tempHome });
    expect(fresh.read().entries).toEqual({});
  });

  it("upsertMany applies all entries atomically", () => {
    const ledger = new Ledger({ endpointUrl: "https://a.test", userId: "u4" }, { cwd: tempHome });
    ledger.upsertMany([makeEntry("s1"), makeEntry("s2"), makeEntry("s3")]);
    expect(Object.keys(ledger.read().entries)).toHaveLength(3);
  });

  it("separate (endpoint,user) keys partition the ledger", () => {
    const a = new Ledger({ endpointUrl: "https://a.test", userId: "user-a" }, { cwd: tempHome });
    const b = new Ledger({ endpointUrl: "https://a.test", userId: "user-b" }, { cwd: tempHome });
    a.upsertEntry(makeEntry("s-from-a"));
    expect(b.getEntry("s-from-a")).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  manifestEntrySchema,
  manifestSchema,
  resumeStateSchema,
  ResumeStore,
  type ManifestEntryState,
  type ManifestState,
  type ResumeState,
} from "./resume.js";
import { nowIso } from "../lib/time.js";

const HASH = "a".repeat(64); // a valid lowercase-hex 64-char content hash.

function entry(overrides: Partial<ManifestEntryState> = {}): ManifestEntryState {
  return {
    sessionId: "sess-1",
    identityDerivation: "native",
    contentHash: HASH,
    byteSize: 10,
    sourceFilePath: "/tmp/sess-1.jsonl",
    rawContentHashAtFirstRun: HASH,
    status: "pending",
    ...overrides,
  };
}

function manifest(entries: ManifestEntryState[]): ManifestState {
  return {
    manifestId: "mfst-1",
    cliVersion: "0.1.0",
    redactionPolicyVersion: "v0.1",
    sourceKind: "claude-code",
    expectedSessionCount: Math.max(1, entries.length),
    endpointUrl: "https://test",
    userId: "user-1",
    entries,
  };
}

function state(entries: ManifestEntryState[]): ResumeState {
  return {
    schemaVersion: 1,
    manifest: manifest(entries),
    beganAt: nowIso(),
  };
}

describe("resume schema validation", () => {
  it("accepts a well-formed entry and rejects a non-hex content hash", () => {
    expect(manifestEntrySchema.safeParse(entry()).success).toBe(true);
    expect(manifestEntrySchema.safeParse(entry({ contentHash: "xyz" })).success).toBe(false);
    // Uppercase hex is rejected (regex is lowercase-only).
    expect(manifestEntrySchema.safeParse(entry({ contentHash: "A".repeat(64) })).success).toBe(
      false,
    );
  });

  it("rejects a negative byteSize and a non-integer byteSize", () => {
    expect(manifestEntrySchema.safeParse(entry({ byteSize: -1 })).success).toBe(false);
    expect(manifestEntrySchema.safeParse(entry({ byteSize: 1.5 })).success).toBe(false);
  });

  it("rejects an unknown status and an unknown failure reason", () => {
    expect(manifestEntrySchema.safeParse(entry({ status: "bogus" as never })).success).toBe(false);
    expect(
      manifestEntrySchema.safeParse(entry({ lastFailureReason: "boom" as never })).success,
    ).toBe(false);
  });

  it("validates optional datetime fields (ackedAt/failedAt)", () => {
    expect(manifestEntrySchema.safeParse(entry({ ackedAt: "not-a-date" })).success).toBe(false);
    expect(manifestEntrySchema.safeParse(entry({ ackedAt: nowIso() })).success).toBe(true);
  });

  it("manifest requires expectedSessionCount >= 1 and a non-empty manifestId", () => {
    expect(
      manifestSchema.safeParse({ ...manifest([entry()]), expectedSessionCount: 0 }).success,
    ).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest([entry()]), manifestId: "" }).success).toBe(
      false,
    );
  });

  it("resume state pins schemaVersion to the literal 1 and requires a datetime beganAt", () => {
    expect(resumeStateSchema.safeParse({ ...state([entry()]), schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(resumeStateSchema.safeParse({ ...state([entry()]), beganAt: "nope" }).success).toBe(
      false,
    );
  });

  it("redactionTotals is optional but rejects negative counts when present", () => {
    expect(
      resumeStateSchema.safeParse({ ...state([entry()]), redactionTotals: { a: 3 } }).success,
    ).toBe(true);
    expect(
      resumeStateSchema.safeParse({ ...state([entry()]), redactionTotals: { a: -1 } }).success,
    ).toBe(false);
  });
});

describe("ResumeStore", () => {
  let cwd: string;
  const key = { endpointUrl: "https://test", userId: "user-1" };

  function newStore(): ResumeStore {
    return new ResumeStore(key, { cwd });
  }

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "frugl-resume-"));
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("load returns null on a fresh store", () => {
    expect(newStore().load()).toBeNull();
  });

  it("save → load round-trips the full state (including redactionTotals)", () => {
    const store = newStore();
    const s = { ...state([entry()]), redactionTotals: { email: 2 } };
    store.save(s);
    // A fresh store instance reading the same on-disk file sees the saved state.
    expect(newStore().load()).toEqual(s);
  });

  it("clear resets the persisted state to null", () => {
    const store = newStore();
    store.save(state([entry()]));
    store.clear();
    expect(newStore().load()).toBeNull();
  });

  it("load tolerates a corrupt/invalid persisted state and self-heals to null", () => {
    const store = newStore();
    // Write a structurally-invalid state directly to the backing file.
    const corrupt = { state: { schemaVersion: 1, manifest: { nope: true }, beganAt: "bad" } };
    writeFileSync(store.path, JSON.stringify(corrupt), "utf8");

    // load returns null AND scrubs the bad state so subsequent loads are clean.
    expect(store.load()).toBeNull();
    const onDisk = JSON.parse(readFileSync(store.path, "utf8")) as { state: unknown };
    expect(onDisk.state).toBeNull();
  });

  it("updateEntry mutates only the matching entry and persists it", () => {
    const store = newStore();
    store.save(state([entry({ sessionId: "a" }), entry({ sessionId: "b" })]));

    store.updateEntry("b", (e) => ({ ...e, status: "acked", ackedAt: nowIso() }));

    const loaded = newStore().load()!;
    const a = loaded.manifest.entries.find((e) => e.sessionId === "a")!;
    const b = loaded.manifest.entries.find((e) => e.sessionId === "b")!;
    expect(a.status).toBe("pending");
    expect(b.status).toBe("acked");
    expect(b.ackedAt).toBeTypeOf("string");
  });

  it("updateEntry is a no-op when there is no persisted state", () => {
    const store = newStore();
    // Must not throw and must not create state.
    store.updateEntry("missing", (e) => ({ ...e, status: "acked" }));
    expect(store.load()).toBeNull();
  });

  it("updateEntry leaves all entries unchanged when the sessionId is unknown", () => {
    const store = newStore();
    const original = state([entry({ sessionId: "a" })]);
    store.save(original);
    store.updateEntry("nonexistent", (e) => ({ ...e, status: "acked" }));
    expect(newStore().load()).toEqual(original);
  });

  it("namespaces the backing file per endpoint+user so distinct keys do not collide", () => {
    const a = new ResumeStore({ endpointUrl: "https://a", userId: "u" }, { cwd });
    const b = new ResumeStore({ endpointUrl: "https://b", userId: "u" }, { cwd });
    expect(a.path).not.toBe(b.path);
    a.save(state([entry()]));
    expect(b.load()).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ledger } from "./ledger.js";
import { classifyAll, bucketize, sortByMtimeDesc, type SessionClassification } from "./classify.js";
import type { ParsedSession, SessionRef, Source } from "../sources/types.js";

const SOURCE_KIND = "test-source";

function buildSource(map: Map<string, unknown[]>): Source {
  return {
    kind: SOURCE_KIND,
    formatVersion: "test-format-v1",
    discover: async () => [],
    parse: async (ref) => {
      const records = map.get(ref.absolutePath) ?? [];
      const parsed: ParsedSession = {
        sourceKind: SOURCE_KIND,
        ref,
        identity: { sessionId: path.basename(ref.absolutePath, ".jsonl"), derivation: "native" },
        records,
      };
      return parsed;
    },
    deriveIdentity: (ref) => ({
      sessionId: path.basename(ref.absolutePath, ".jsonl"),
      derivation: "native",
    }),
  };
}

function makeRef(absolutePath: string, mtimeMs: number, byteSize = 100): SessionRef {
  return { sourceKind: SOURCE_KIND, absolutePath, mtimeMs, byteSizeOnDisk: byteSize };
}

describe("classify", () => {
  let tempHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), "frugl-classify-"));
    prevHome = process.env["XDG_DATA_HOME"];
    process.env["XDG_DATA_HOME"] = tempHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env["XDG_DATA_HOME"];
    else process.env["XDG_DATA_HOME"] = prevHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("classifies new sessions when not in ledger", async () => {
    const ledger = new Ledger({ endpointUrl: "https://a.test", userId: "u1" }, { cwd: tempHome });
    const refs = [makeRef("/abs/sess-1.jsonl", 1)];
    const source = buildSource(new Map([["/abs/sess-1.jsonl", [{ a: 1 }]]]));
    const results = await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "u", ownerEmail: "o@x.com" },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("new");
  });

  it("classifies unchanged sessions when hash matches ledger", async () => {
    const ledger = new Ledger({ endpointUrl: "https://b.test", userId: "u2" }, { cwd: tempHome });
    const refs = [makeRef("/abs/sess-2.jsonl", 1)];
    const source = buildSource(new Map([["/abs/sess-2.jsonl", [{ msg: "hi" }]]]));

    const first = await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "u", ownerEmail: "o@x.com" },
    });
    const firstNew = first[0];
    if (firstNew?.kind !== "new") throw new Error("expected new");
    ledger.upsertEntry({
      sessionId: firstNew.identity.sessionId,
      contentHash: firstNew.anonymizationResult.contentHashHex,
      lastUploadedAt: new Date().toISOString(),
      manifestId: "m-1",
    });

    const second = await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "u", ownerEmail: "o@x.com" },
    });
    expect(second[0]?.kind).toBe("unchanged");
  });

  it("stays unchanged across runs with different uploadIds (deterministic hash)", async () => {
    const ledger = new Ledger(
      { endpointUrl: "https://salt.test", userId: "u-salt" },
      { cwd: tempHome },
    );
    const refs = [makeRef("/abs/sess-salt.jsonl", 1)];
    // A home path forces pseudonymization, whose HMAC key is the per-run uploadId.
    const records = [{ msg: "see /Users/alice/proj/file.ts" }];
    const source = buildSource(new Map([["/abs/sess-salt.jsonl", records]]));

    const first = await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "upload-A", ownerEmail: "o@x.com" },
    });
    const firstNew = first[0];
    if (firstNew?.kind !== "new") throw new Error("expected new");
    ledger.upsertEntry({
      sessionId: firstNew.identity.sessionId,
      contentHash: firstNew.anonymizationResult.contentHashHex,
      lastUploadedAt: new Date().toISOString(),
      manifestId: "m-A",
    });

    // Second upload run: identical content, different uploadId (new salt).
    const second = await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "upload-B", ownerEmail: "o@x.com" },
    });
    expect(second[0]?.kind).toBe("unchanged");
  });

  it("classifies updated sessions when payload hash differs", async () => {
    const ledger = new Ledger({ endpointUrl: "https://c.test", userId: "u3" }, { cwd: tempHome });
    const refs = [makeRef("/abs/sess-3.jsonl", 1)];
    const records1: unknown[] = [{ msg: "first" }];
    const records2: unknown[] = [{ msg: "second" }];

    const map = new Map<string, unknown[]>([["/abs/sess-3.jsonl", records1]]);
    const source = buildSource(map);
    const first = await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "u", ownerEmail: "o@x.com" },
    });
    const firstNew = first[0];
    if (firstNew?.kind !== "new") throw new Error("expected new");
    ledger.upsertEntry({
      sessionId: firstNew.identity.sessionId,
      contentHash: firstNew.anonymizationResult.contentHashHex,
      lastUploadedAt: new Date().toISOString(),
      manifestId: "m-1",
    });

    map.set("/abs/sess-3.jsonl", records2);
    const second = await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "u", ownerEmail: "o@x.com" },
    });
    const updated = second[0];
    if (updated?.kind !== "updated") throw new Error("expected updated");
    expect(updated.kind).toBe("updated");
    expect(updated.identity.sessionId).toBe(firstNew.identity.sessionId);
  });

  it("handles incremental scenario: M existing + K new + L updated", async () => {
    const ledger = new Ledger({ endpointUrl: "https://d.test", userId: "u4" }, { cwd: tempHome });
    const map = new Map<string, unknown[]>();
    const M = 4;
    const refs: SessionRef[] = [];
    for (let i = 0; i < M; i++) {
      const p = `/abs/m-${i}.jsonl`;
      map.set(p, [{ msg: `m-${i}` }]);
      refs.push(makeRef(p, i));
    }
    const source = buildSource(map);
    const initial = await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "u", ownerEmail: "o@x.com" },
    });
    for (const c of initial) {
      if (c.kind === "new") {
        ledger.upsertEntry({
          sessionId: c.identity.sessionId,
          contentHash: c.anonymizationResult.contentHashHex,
          lastUploadedAt: new Date().toISOString(),
          manifestId: "m-init",
        });
      }
    }

    const K = 2;
    for (let i = 0; i < K; i++) {
      const p = `/abs/k-${i}.jsonl`;
      map.set(p, [{ msg: `k-${i}` }]);
      refs.push(makeRef(p, M + i));
    }
    const L = 2;
    for (let i = 0; i < L; i++) {
      map.set(`/abs/m-${i}.jsonl`, [{ msg: `m-${i}`, extra: "appended" }]);
    }

    const second = await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "u", ownerEmail: "o@x.com" },
    });
    const buckets = bucketize(second);
    expect(buckets.new).toHaveLength(K);
    expect(buckets.updated).toHaveLength(L);
    expect(buckets.unchanged).toHaveLength(M - L);
  });

  it("classifyAll: 1000 sessions classification completes ≤ 5 s (SC-003a)", async () => {
    const ledger = new Ledger(
      { endpointUrl: "https://sc003a.perf.test", userId: "u-perf" },
      { cwd: tempHome },
    );
    const map = new Map<string, unknown[]>();
    const refs: SessionRef[] = [];
    for (let i = 0; i < 1000; i++) {
      const p = `/perf/sess-${i}.jsonl`;
      map.set(p, [
        { sessionId: `s-${i}`, type: "user", message: `Hello from test session ${i}` },
        { sessionId: `s-${i}`, type: "assistant", message: `Assistant response ${i}` },
      ]);
      refs.push(makeRef(p, i, 300));
    }
    const source = buildSource(map);
    const start = performance.now();
    await classifyAll(refs, {
      ledger,
      source,
      anonymize: { uploadId: "u-perf", ownerEmail: "perf@example.com" },
    });
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(5_000);
  }, 10_000);

  it("sortByMtimeDesc orders by mtime desc, path asc tiebreaker", () => {
    const items: SessionClassification[] = [
      {
        kind: "new",
        ref: makeRef("/c.jsonl", 1),
        identity: { sessionId: "c", derivation: "native" },
        anonymizationResult: stubResult(),
        parsed: stubParsed("c"),
      },
      {
        kind: "new",
        ref: makeRef("/a.jsonl", 2),
        identity: { sessionId: "a", derivation: "native" },
        anonymizationResult: stubResult(),
        parsed: stubParsed("a"),
      },
      {
        kind: "new",
        ref: makeRef("/b.jsonl", 2),
        identity: { sessionId: "b", derivation: "native" },
        anonymizationResult: stubResult(),
        parsed: stubParsed("b"),
      },
    ];
    const sorted = sortByMtimeDesc(items);
    expect(sorted.map((x) => x.ref.absolutePath)).toEqual(["/a.jsonl", "/b.jsonl", "/c.jsonl"]);
  });
});

function stubResult() {
  return {
    payload: {},
    redactionsByCategory: {} as never,
    policyVersion: "v0.1",
    redactedHashHex: "0".repeat(64),
    contentHashHex: "0".repeat(64),
    byteSize: 0,
  };
}

function stubParsed(name: string): ParsedSession {
  return {
    sourceKind: SOURCE_KIND,
    ref: makeRef(`/${name}.jsonl`, 0),
    identity: { sessionId: name, derivation: "native" },
    records: [],
  };
}

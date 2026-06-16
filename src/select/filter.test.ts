import { describe, expect, it } from "vitest";
import {
  filterTrivial,
  computeSessionCostUSD,
  filterByCost,
  classifyTier,
  computeSessionMetrics,
} from "./filter.js";
import type { SessionClassification } from "../ledger/classify.js";
import type { SessionRef } from "../sources/types.js";

// ── helpers ────────────────────────────────────────────────────────────────────

function ref(p = "/a/1.jsonl"): SessionRef {
  return {
    sourceKind: "claude-code",
    absolutePath: p,
    byteSizeOnDisk: 100,
    mtimeMs: 1,
  };
}

function identity(sessionId = "sid-1") {
  return { sessionId, derivation: "native" as const };
}

function parsed(records: unknown[], p = "/a/1.jsonl") {
  return {
    sourceKind: "claude-code",
    ref: ref(p),
    identity: identity(),
    records,
  };
}

function assistantRecord(model: string, usage: Record<string, number>): unknown {
  return { message: { role: "assistant", model, usage } };
}

function userRecord(): unknown {
  return { message: { role: "user" }, type: "human" };
}

function newItem(records: unknown[], p = "/a/1.jsonl"): SessionClassification {
  return {
    kind: "new",
    ref: ref(p),
    identity: identity(p),
    anonymizationResult: {
      contentHashHex: "abc",
      byteSize: 10,
      redactionsByCategory: {},
    } as any,
    parsed: parsed(records, p),
  };
}

function updatedItem(records: unknown[], p = "/a/2.jsonl"): SessionClassification {
  return {
    kind: "updated",
    ref: ref(p),
    identity: identity(p),
    previousEntry: {
      sessionId: p,
      contentHash: "x".repeat(64),
      lastUploadedAt: new Date().toISOString(),
      manifestId: "m1",
    },
    anonymizationResult: {
      contentHashHex: "def",
      byteSize: 10,
      redactionsByCategory: {},
    } as any,
    parsed: parsed(records, p),
  };
}

function unchangedItem(p = "/a/3.jsonl"): SessionClassification {
  return {
    kind: "unchanged",
    ref: ref(p),
    identity: identity(p),
    ledgerEntry: {
      sessionId: p,
      contentHash: "y".repeat(64),
      lastUploadedAt: new Date().toISOString(),
      manifestId: "m1",
    },
  };
}

// ── filterTrivial ──────────────────────────────────────────────────────────────

describe("filterTrivial", () => {
  it("keeps sessions with at least one assistant response", () => {
    const item = newItem([
      userRecord(),
      assistantRecord("claude-sonnet-4-6", { output_tokens: 100 }),
    ]);
    expect(filterTrivial([item])).toHaveLength(1);
  });

  it("drops sessions with no assistant response", () => {
    const item = newItem([userRecord(), { type: "system" }]);
    expect(filterTrivial([item])).toHaveLength(0);
  });

  it("drops updated sessions with no assistant response", () => {
    const item = updatedItem([userRecord()]);
    expect(filterTrivial([item])).toHaveLength(0);
  });

  it("always keeps unchanged items (no records available)", () => {
    expect(filterTrivial([unchangedItem()])).toHaveLength(1);
  });

  it("handles empty record list", () => {
    expect(filterTrivial([newItem([])])).toHaveLength(0);
  });

  it("handles malformed records without throwing", () => {
    const item = newItem([null, undefined, 42, "string", { message: null }]);
    expect(filterTrivial([item])).toHaveLength(0);
  });
});

// ── computeSessionCostUSD ──────────────────────────────────────────────────────

describe("computeSessionCostUSD", () => {
  it("returns 0 for an empty session", () => {
    expect(computeSessionCostUSD([])).toBe(0);
  });

  it("returns 0 when there are no assistant records", () => {
    expect(computeSessionCostUSD([userRecord()])).toBe(0);
  });

  it("computes Sonnet cost correctly", () => {
    const records = [
      assistantRecord("claude-sonnet-4-6", {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    // input: 1000 * 3/1e6 = 0.003, output: 500 * 15/1e6 = 0.0075 → 0.0105
    expect(computeSessionCostUSD(records)).toBeCloseTo(0.0105, 6);
  });

  it("computes Opus cost correctly", () => {
    const records = [
      assistantRecord("claude-opus-4-8", {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    // input: 1000 * 15/1e6 = 0.015, output: 500 * 75/1e6 = 0.0375 → 0.0525
    expect(computeSessionCostUSD(records)).toBeCloseTo(0.0525, 6);
  });

  it("computes Haiku cost correctly", () => {
    const records = [
      assistantRecord("claude-haiku-4-5", {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    // input: 1000 * 0.8/1e6 = 0.0008, output: 500 * 4/1e6 = 0.002 → 0.0028
    expect(computeSessionCostUSD(records)).toBeCloseTo(0.0028, 6);
  });

  it("includes cache token costs", () => {
    const records = [
      assistantRecord("claude-sonnet-4-6", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      }),
    ];
    // cache_create: 3.75, cache_read: 0.30
    expect(computeSessionCostUSD(records)).toBeCloseTo(4.05, 6);
  });

  it("sums cost across multiple assistant records", () => {
    const records = [
      assistantRecord("claude-sonnet-4-6", { output_tokens: 1_000_000 }),
      assistantRecord("claude-sonnet-4-6", { output_tokens: 1_000_000 }),
    ];
    // 2 * 15 = $30
    expect(computeSessionCostUSD(records)).toBeCloseTo(30, 4);
  });

  it("falls back to Sonnet pricing for unknown models", () => {
    const records = [assistantRecord("unknown-model-xyz", { input_tokens: 1_000_000 })];
    expect(computeSessionCostUSD(records)).toBeCloseTo(3.0, 6);
  });
});

// ── filterByCost ───────────────────────────────────────────────────────────────

// ~$5 session
const cheapRecords = [
  assistantRecord("claude-sonnet-4-6", { output_tokens: 333_000 }), // ~$5
];

// ~$75 session
const expensiveRecords = [
  assistantRecord("claude-opus-4-8", { output_tokens: 1_000_000 }), // $75
];

describe("filterByCost", () => {
  it("keeps sessions at or above the threshold", () => {
    const items = [newItem(cheapRecords, "/a/1.jsonl"), newItem(expensiveRecords, "/a/2.jsonl")];
    const result = filterByCost(items, 10);
    expect(result).toHaveLength(1);
    expect(result[0]!.ref.absolutePath).toBe("/a/2.jsonl");
  });

  it("keeps sessions exactly at the threshold", () => {
    // cheapRecords ≈ $5 (333k output tokens * $15/MTok)
    const items = [newItem(cheapRecords, "/a/1.jsonl")];
    const result = filterByCost(items, 0);
    expect(result).toHaveLength(1);
  });

  it("drops sessions below the threshold", () => {
    const items = [newItem(cheapRecords, "/a/1.jsonl")];
    expect(filterByCost(items, 100)).toHaveLength(0);
  });

  it("always keeps unchanged items (no parsed records)", () => {
    const items: SessionClassification[] = [
      unchangedItem("/a/3.jsonl"),
      newItem(cheapRecords, "/a/1.jsonl"),
    ];
    const result = filterByCost(items, 100);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("unchanged");
  });
});

// ── classifyTier (spec 054) ─────────────────────────────────────────────────────

describe("classifyTier", () => {
  it("excludes sessions below the $0.01 floor", () => {
    expect(classifyTier(0.009, 10)).toBe("excluded");
    expect(classifyTier(0, 10)).toBe("excluded");
  });

  it("treats the $0.01 floor as inclusive (metadata)", () => {
    expect(classifyTier(0.01, 10)).toBe("metadata");
  });

  it("classifies between the floor and min-cost as metadata", () => {
    expect(classifyTier(4.2, 10)).toBe("metadata");
    expect(classifyTier(9.99, 10)).toBe("metadata");
  });

  it("treats the min-cost threshold as inclusive (full)", () => {
    expect(classifyTier(10, 10)).toBe("full");
  });

  it("classifies at/above min-cost as full", () => {
    expect(classifyTier(25, 10)).toBe("full");
  });
});

// ── computeSessionMetrics (spec 054) ────────────────────────────────────────────

function assistantWithTs(model: string, usage: Record<string, number>, ts: string): unknown {
  return { timestamp: ts, message: { role: "assistant", model, usage } };
}

describe("computeSessionMetrics", () => {
  it("sums tokens + cost, picks the primary model, and maps the vendor", () => {
    const records = [
      { timestamp: "2026-06-15T10:00:00.000Z", message: { role: "user" } },
      assistantWithTs(
        "claude-sonnet-4-6",
        { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 },
        "2026-06-15T10:01:00.000Z",
      ),
    ];
    const m = computeSessionMetrics(records);
    expect(m.cost_basis).toBe("cli");
    expect(m.partial_data).toBe(true);
    expect(m.input_tokens).toBe(1000);
    expect(m.output_tokens).toBe(500);
    expect(m.cache_read_tokens).toBe(200);
    expect(m.total_tokens).toBe(1700);
    expect(m.turn_count).toBe(1); // one user turn
    expect(m.primary_model).toBe("claude-sonnet-4-6");
    expect(m.model_provider).toBe("anthropic");
    expect(m.started_at).toBe("2026-06-15T10:00:00.000Z");
    expect(m.ended_at).toBe("2026-06-15T10:01:00.000Z");
    expect(m.models).toHaveLength(1);
    // Session-level cost equals the standalone cost computation (consistency).
    expect(m.total_cost_usd).toBeCloseTo(computeSessionCostUSD(records), 9);
  });

  it("fans out per-model and picks the highest-token model as primary", () => {
    const records = [
      assistantWithTs("claude-haiku-4-5", { output_tokens: 100 }, "2026-06-15T10:00:00.000Z"),
      assistantWithTs("claude-opus-4-8", { output_tokens: 5000 }, "2026-06-15T10:02:00.000Z"),
    ];
    const m = computeSessionMetrics(records);
    expect(m.models.map((x) => x.model).toSorted()).toEqual(
      ["claude-haiku-4-5", "claude-opus-4-8"].toSorted(),
    );
    expect(m.primary_model).toBe("claude-opus-4-8");
  });

  it("handles a session with no assistant usage (empty models, zero totals)", () => {
    const m = computeSessionMetrics([userRecord(), userRecord()]);
    expect(m.models).toEqual([]);
    expect(m.total_cost_usd).toBe(0);
    expect(m.primary_model).toBeNull();
    expect(m.model_provider).toBeNull();
    expect(m.turn_count).toBe(2);
    expect(m.started_at).toBeNull();
  });
});

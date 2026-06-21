import type { SessionClassification } from "../ledger/classify.js";

// ── provider session metrics ───────────────────────────────────────────────────

// Returns true when the record set contains at least one assistant response.
// A session with no assistant turn never produced useful output.
function hasAssistantResponse(records: unknown[], sourceKind = "claude-code"): boolean {
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (sourceKind === "codex" && isCodexAgentMessage(record)) return true;
    const msg = (record as Record<string, unknown>)["message"];
    if (!msg || typeof msg !== "object") continue;
    if ((msg as Record<string, unknown>)["role"] === "assistant") return true;
  }
  return false;
}

// Removes sessions that produced no assistant response — they ended before
// anything useful happened. `unchanged` items are always kept (we have no
// records for them and they're not being uploaded anyway).
export function filterTrivial(items: SessionClassification[]): SessionClassification[] {
  return items.filter(
    (c) => c.kind === "unchanged" || hasAssistantResponse(c.parsed.records, c.ref.sourceKind),
  );
}

// ── cost filter ────────────────────────────────────────────────────────────────

interface TokenPricing {
  inputPerMTok: number;
  cacheCreatePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
}

const OPUS_PRICING: TokenPricing = {
  inputPerMTok: 15.0,
  cacheCreatePerMTok: 18.75,
  cacheReadPerMTok: 1.5,
  outputPerMTok: 75.0,
};

const SONNET_PRICING: TokenPricing = {
  inputPerMTok: 3.0,
  cacheCreatePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
  outputPerMTok: 15.0,
};

const HAIKU_PRICING: TokenPricing = {
  inputPerMTok: 0.8,
  cacheCreatePerMTok: 1.0,
  cacheReadPerMTok: 0.08,
  outputPerMTok: 4.0,
};

const GPT5_PRICING: TokenPricing = {
  inputPerMTok: 12,
  cacheCreatePerMTok: 0,
  cacheReadPerMTok: 3,
  outputPerMTok: 48,
};

const GPT4O_PRICING: TokenPricing = {
  inputPerMTok: 2.5,
  cacheCreatePerMTok: 0,
  cacheReadPerMTok: 1.25,
  outputPerMTok: 10,
};

const GPT4O_MINI_PRICING: TokenPricing = {
  inputPerMTok: 0.15,
  cacheCreatePerMTok: 0,
  cacheReadPerMTok: 0.075,
  outputPerMTok: 0.6,
};

const O1_PRICING: TokenPricing = {
  inputPerMTok: 15,
  cacheCreatePerMTok: 0,
  cacheReadPerMTok: 7.5,
  outputPerMTok: 60,
};

const O3_PRICING: TokenPricing = {
  inputPerMTok: 10,
  cacheCreatePerMTok: 0,
  cacheReadPerMTok: 2.5,
  outputPerMTok: 40,
};

const O3_MINI_PRICING: TokenPricing = {
  inputPerMTok: 1.1,
  cacheCreatePerMTok: 0,
  cacheReadPerMTok: 0.55,
  outputPerMTok: 4.4,
};

const O4_MINI_PRICING: TokenPricing = {
  inputPerMTok: 1.1,
  cacheCreatePerMTok: 0,
  cacheReadPerMTok: 0.275,
  outputPerMTok: 4.4,
};

function getPricing(model: string): TokenPricing {
  const m = model.toLowerCase();
  if (m === "gpt-4o-mini" || m.startsWith("gpt-4o-mini-")) return GPT4O_MINI_PRICING;
  if (m === "gpt-4o" || m.startsWith("gpt-4o-")) return GPT4O_PRICING;
  if (m === "gpt-5" || m.startsWith("gpt-5-")) return GPT5_PRICING;
  if (m === "o3-mini" || m.startsWith("o3-mini-")) return O3_MINI_PRICING;
  if (m === "o4-mini" || m.startsWith("o4-mini-")) return O4_MINI_PRICING;
  if (m === "o1" || m.startsWith("o1-")) return O1_PRICING;
  if (m === "o3" || m.startsWith("o3-")) return O3_PRICING;
  if (m.includes("opus")) return OPUS_PRICING;
  if (m.includes("haiku")) return HAIKU_PRICING;
  return SONNET_PRICING;
}

function priceTokens(
  model: string,
  tokens: {
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
  },
): number {
  const pricing = getPricing(model);
  return (
    (tokens.input * pricing.inputPerMTok +
      tokens.cacheCreate * pricing.cacheCreatePerMTok +
      tokens.cacheRead * pricing.cacheReadPerMTok +
      tokens.output * pricing.outputPerMTok) /
    1_000_000
  );
}

function recordCostUSD(record: unknown): number {
  if (!record || typeof record !== "object") return 0;
  const msg = (record as Record<string, unknown>)["message"];
  if (!msg || typeof msg !== "object") return 0;
  const m = msg as Record<string, unknown>;
  if (m["role"] !== "assistant") return 0;
  const usage = m["usage"];
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const model = typeof m["model"] === "string" ? m["model"] : "";
  const input = typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0;
  const cacheCreate =
    typeof u["cache_creation_input_tokens"] === "number" ? u["cache_creation_input_tokens"] : 0;
  const cacheRead =
    typeof u["cache_read_input_tokens"] === "number" ? u["cache_read_input_tokens"] : 0;
  const output = typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0;
  return priceTokens(model, { input, output, cacheCreate, cacheRead });
}

export function computeSessionCostUSD(records: unknown[], sourceKind = "claude-code"): number {
  if (sourceKind === "codex") return computeCodexUsage(records)?.totalCost ?? 0;
  let total = 0;
  for (const record of records) total += recordCostUSD(record);
  return total;
}

// ── tiered upload classification (spec 054) ─────────────────────────────────────

// Below this, a session is treated as empty/noise and not sent at all — neither
// raw nor metadata. A proxy for "nothing useful happened" (FR-002).
export const EXCLUDE_FLOOR_USD = 0.01;

// A session's upload tier, by its locally-computed cost:
//   excluded   cost <  $0.01        — send nothing (likely empty)
//   metadata   $0.01 <= cost < min  — send compact metrics only, no raw
//   full       cost >= min          — upload raw + parse, as today
export type SessionTier = "excluded" | "metadata" | "full";

// Both boundaries are inclusive at the lower bound of the higher tier (FR-001).
export function classifyTier(costUsd: number, minCostUsd: number): SessionTier {
  if (costUsd < EXCLUDE_FLOOR_USD) return "excluded";
  if (costUsd < minCostUsd) return "metadata";
  return "full";
}

// Per-model usage for a metadata-only session, mirroring the cloud's
// session_model_usage columns (no provider column — provider is session-level).
export interface SessionModelUsageMetric {
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
}

// The compact metrics block the CLI sends for a metadata-only session, since
// there is no raw object for the server to parse (spec 054). Numeric-only plus
// model identity; mirrors the cloud's SessionMetrics contract.
export interface SessionMetrics {
  cost_basis: "cli";
  total_cost_usd: number | null;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  reasoning_tokens: number | null;
  turn_count: number;
  started_at: string | null;
  ended_at: string | null;
  primary_model: string | null;
  model_provider: string | null;
  partial_data: boolean;
  models: SessionModelUsageMetric[];
}

// Per-model running totals while walking the records once.
interface ModelAccum {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  cost: number;
}

function vendorOfModel(model: string): string | null {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (m.includes("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.includes("gemini")) return "google";
  return null;
}

function recordTimestamp(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const ts = (record as Record<string, unknown>)["timestamp"];
  return typeof ts === "string" && ts.length > 0 ? ts : null;
}

// Compute the metadata metrics for a session in a single pass over its records,
// using the same Claude-shaped usage extraction as the cost computation so the
// numbers are consistent with the tier decision. Per-model token sums + cost fan
// out to session_model_usage on the cloud; the session-level totals are their
// sums. `turn_count` counts developer (user) turns. Timestamps come from the
// records' `timestamp` fields (min/max). Always `partial_data` — a metadata-only
// session has no message/tool detail.
export function computeSessionMetrics(
  records: unknown[],
  sourceKind = "claude-code",
): SessionMetrics {
  if (sourceKind === "codex") return computeCodexSessionMetrics(records);

  const perModel = new Map<string, ModelAccum>();
  let turnCount = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  for (const record of records) {
    const ts = recordTimestamp(record);
    if (ts) {
      if (startedAt === null || ts < startedAt) startedAt = ts;
      if (endedAt === null || ts > endedAt) endedAt = ts;
    }
    if (!record || typeof record !== "object") continue;
    const msg = (record as Record<string, unknown>)["message"];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m["role"] === "user") turnCount += 1;
    if (m["role"] !== "assistant") continue;
    const usage = m["usage"];
    if (!usage || typeof usage !== "object") continue;
    const u = usage as Record<string, unknown>;
    const model = typeof m["model"] === "string" && m["model"] ? m["model"] : "unknown";
    const input = typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0;
    const cacheCreate =
      typeof u["cache_creation_input_tokens"] === "number" ? u["cache_creation_input_tokens"] : 0;
    const cacheRead =
      typeof u["cache_read_input_tokens"] === "number" ? u["cache_read_input_tokens"] : 0;
    const output = typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0;
    const acc = perModel.get(model) ?? {
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      cost: 0,
    };
    acc.input += input;
    acc.output += output;
    acc.cacheCreate += cacheCreate;
    acc.cacheRead += cacheRead;
    acc.cost += recordCostUSD(record);
    perModel.set(model, acc);
  }

  const models: SessionModelUsageMetric[] = [...perModel.entries()].map(([model, a]) => ({
    model,
    input_tokens: a.input,
    output_tokens: a.output,
    cache_creation_tokens: a.cacheCreate,
    cache_read_tokens: a.cacheRead,
    reasoning_tokens: null,
    cost_usd: a.cost,
  }));

  // Primary model = the one with the most total tokens (input+output+cache).
  let primaryModel: string | null = null;
  let primaryTokens = -1;
  for (const m of models) {
    const t =
      (m.input_tokens ?? 0) +
      (m.output_tokens ?? 0) +
      (m.cache_creation_tokens ?? 0) +
      (m.cache_read_tokens ?? 0);
    if (t > primaryTokens) {
      primaryTokens = t;
      primaryModel = m.model;
    }
  }

  const sum = (pick: (a: ModelAccum) => number): number => {
    let t = 0;
    for (const a of perModel.values()) t += pick(a);
    return t;
  };
  const inputTokens = sum((a) => a.input);
  const outputTokens = sum((a) => a.output);
  const cacheCreationTokens = sum((a) => a.cacheCreate);
  const cacheReadTokens = sum((a) => a.cacheRead);
  const totalCost = sum((a) => a.cost);

  return {
    cost_basis: "cli",
    total_cost_usd: totalCost,
    total_tokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_read_tokens: cacheReadTokens,
    reasoning_tokens: null,
    turn_count: turnCount,
    started_at: startedAt,
    ended_at: endedAt,
    primary_model: primaryModel,
    model_provider: primaryModel ? vendorOfModel(primaryModel) : null,
    partial_data: true,
    models,
  };
}

// Filters `new`/`updated` candidates to those whose estimated cost meets the
// minimum USD threshold. `unchanged` items pass through (no parsed records).
export function filterByCost(
  items: SessionClassification[],
  minCost: number,
): SessionClassification[] {
  return items.filter((c) => {
    if (c.kind === "unchanged") return true;
    return computeSessionCostUSD(c.parsed.records, c.ref.sourceKind) >= minCost;
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function codexPayload(record: unknown): Record<string, unknown> | null {
  if (!isObject(record) || record["type"] !== "event_msg") return null;
  const payload = record["payload"];
  return isObject(payload) ? payload : null;
}

function isCodexAgentMessage(record: unknown): boolean {
  return codexPayload(record)?.["type"] === "agent_message";
}

function isCodexUserMessage(record: unknown): boolean {
  return codexPayload(record)?.["type"] === "user_message";
}

function readCodexModel(records: unknown[]): string {
  for (const record of records) {
    if (!isObject(record) || record["type"] !== "turn_context") continue;
    const payload = record["payload"];
    if (!isObject(payload)) continue;
    const model = payload["model"];
    if (typeof model === "string" && model.length > 0) return model;
  }
  return "unknown";
}

interface CodexUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  totalTokens: number;
  totalCost: number;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function computeCodexUsage(records: unknown[]): CodexUsage | null {
  const selected = { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 };
  let observed = false;
  for (const record of records) {
    const payload = codexPayload(record);
    if (payload?.["type"] !== "token_count") continue;
    const info = payload["info"];
    if (!isObject(info)) continue;
    const usage = info["total_token_usage"];
    if (!isObject(usage)) continue;
    observed = true;
    selected.input = finiteNumber(usage["input_tokens"]) ?? selected.input;
    selected.cacheRead = finiteNumber(usage["cached_input_tokens"]) ?? selected.cacheRead;
    selected.output = finiteNumber(usage["output_tokens"]) ?? selected.output;
    selected.reasoning = finiteNumber(usage["reasoning_output_tokens"]) ?? selected.reasoning;
    selected.total = finiteNumber(usage["total_tokens"]) ?? selected.total;
  }
  if (!observed) return null;

  const model = readCodexModel(records);
  const input = Math.max(0, selected.input - selected.cacheRead);
  const totalTokens = selected.total || input + selected.cacheRead + selected.output;
  const totalCost = priceTokens(model, {
    input,
    output: selected.output,
    cacheCreate: 0,
    cacheRead: selected.cacheRead,
  });
  return {
    model,
    input,
    output: selected.output,
    cacheRead: selected.cacheRead,
    reasoning: selected.reasoning,
    totalTokens,
    totalCost,
  };
}

function computeCodexSessionMetrics(records: unknown[]): SessionMetrics {
  let turnCount = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  for (const record of records) {
    const ts = recordTimestamp(record);
    if (ts) {
      if (startedAt === null || ts < startedAt) startedAt = ts;
      if (endedAt === null || ts > endedAt) endedAt = ts;
    }
    if (isCodexUserMessage(record)) turnCount += 1;
  }

  const usage = computeCodexUsage(records);
  if (usage === null) {
    return {
      cost_basis: "cli",
      total_cost_usd: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      reasoning_tokens: 0,
      turn_count: turnCount,
      started_at: startedAt,
      ended_at: endedAt,
      primary_model: null,
      model_provider: null,
      partial_data: true,
      models: [],
    };
  }

  return {
    cost_basis: "cli",
    total_cost_usd: usage.totalCost,
    total_tokens: usage.totalTokens,
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_creation_tokens: 0,
    cache_read_tokens: usage.cacheRead,
    reasoning_tokens: usage.reasoning,
    turn_count: turnCount,
    started_at: startedAt,
    ended_at: endedAt,
    primary_model: usage.model,
    model_provider: vendorOfModel(usage.model),
    partial_data: true,
    models: [
      {
        model: usage.model,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_creation_tokens: 0,
        cache_read_tokens: usage.cacheRead,
        reasoning_tokens: usage.reasoning,
        cost_usd: usage.totalCost,
      },
    ],
  };
}

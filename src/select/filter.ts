import type { SessionClassification } from "../ledger/classify.js";

// ── trivial-session filter ─────────────────────────────────────────────────────

// Returns true when the record set contains at least one assistant response.
// A session with no assistant turn never produced useful output.
function hasAssistantResponse(records: unknown[]): boolean {
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
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
  return items.filter((c) => c.kind === "unchanged" || hasAssistantResponse(c.parsed.records));
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

function getPricing(model: string): TokenPricing {
  const m = model.toLowerCase();
  if (m.includes("opus")) return OPUS_PRICING;
  if (m.includes("haiku")) return HAIKU_PRICING;
  return SONNET_PRICING;
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
  const pricing = getPricing(model);
  const input = typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0;
  const cacheCreate =
    typeof u["cache_creation_input_tokens"] === "number" ? u["cache_creation_input_tokens"] : 0;
  const cacheRead =
    typeof u["cache_read_input_tokens"] === "number" ? u["cache_read_input_tokens"] : 0;
  const output = typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0;
  return (
    (input * pricing.inputPerMTok +
      cacheCreate * pricing.cacheCreatePerMTok +
      cacheRead * pricing.cacheReadPerMTok +
      output * pricing.outputPerMTok) /
    1_000_000
  );
}

export function computeSessionCostUSD(records: unknown[]): number {
  let total = 0;
  for (const record of records) total += recordCostUSD(record);
  return total;
}

// Filters `new`/`updated` candidates to those whose estimated cost meets the
// minimum USD threshold. `unchanged` items pass through (no parsed records).
export function filterByCost(
  items: SessionClassification[],
  minCost: number,
): SessionClassification[] {
  return items.filter((c) => {
    if (c.kind === "unchanged") return true;
    return computeSessionCostUSD(c.parsed.records) >= minCost;
  });
}

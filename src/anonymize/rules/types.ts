import type { RedactionCategory } from "../policy.js";
import type { PseudonymTable } from "../pseudonyms.js";

// Read-only collaborator bundle handed to every rule. The PseudonymTable is the
// only stateful member (deterministic HMAC keyed by uploadId); rules never
// mutate the context.
export interface RuleContext {
  readonly pseudonyms: PseudonymTable;
  readonly ownerEmail: string;
  readonly homeDir?: string;
}

export interface RuleResult {
  readonly output: string;
  readonly counts: Partial<Record<RedactionCategory, number>>;
}

export interface Rule {
  // Stable, audit-visible identifier: "secrets", "claude-paths", "emails",
  // "entropy". Must be unique across the registry (asserted by the coherence
  // test).
  readonly id: string;
  // The categories this rule may emit. Drives policy coherence:
  // REDACTION_CATEGORIES is derived from the union of these across the registry.
  readonly categories: readonly RedactionCategory[];
  // Pure transform. Throwing is honored by the fail-closed orchestrator: any
  // throw aborts the entire payload with no partial output.
  apply(input: string, ctx: RuleContext): RuleResult;
}

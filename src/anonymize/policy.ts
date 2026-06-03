import { RULES } from "./rules/registry.js";

export const POLICY_VERSION = "v0.1" as const;

export type RedactionCategory =
  | "anthropic-key"
  | "openai-key"
  | "aws-key"
  | "gcp-key"
  | "github-token"
  | "slack-webhook"
  | "env-line"
  | "home-path"
  | "project-name"
  | "third-party-email"
  | "entropy-fallback";

// Derived from the registry so the public category list cannot drift from the
// rules that actually run. The deduped flatten of RULES' `categories` is, by
// construction, identical to the historical literal order
// (secrets → claude-paths → emails → entropy); the coherence test asserts this
// and snapshots (POLICY_VERSION, ordered category list) so any change fails CI
// without a deliberate POLICY_VERSION bump.
export const REDACTION_CATEGORIES: readonly RedactionCategory[] = dedupe(
  RULES.flatMap((rule) => rule.categories),
);

function dedupe(categories: readonly RedactionCategory[]): RedactionCategory[] {
  const seen = new Set<RedactionCategory>();
  const result: RedactionCategory[] = [];
  for (const category of categories) {
    if (seen.has(category)) continue;
    seen.add(category);
    result.push(category);
  }
  return result;
}

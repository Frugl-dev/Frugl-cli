import { claudePathsRule } from "./claude-paths.js";
import { emailsRule } from "./emails.js";
import { entropyRule } from "./entropy.js";
import { secretsRule } from "./secrets.js";
import type { Rule } from "./types.js";

// THE ordered, auditable ruleset. This single literal array is the source of
// truth for both which rules run and in what order, and (via their `categories`)
// for the public REDACTION_CATEGORIES list in policy.ts.
//
// ORDER IS SECURITY-RELEVANT. Do not reorder, sort, or filter at runtime, and do
// not reorder this literal without a security review and a deliberate
// POLICY_VERSION bump (the coherence test snapshots this order):
//
//   1. secrets      — structured, high-confidence patterns first. Running these
//                     before the entropy catch-all ensures known secret shapes
//                     are redacted with their precise category rather than the
//                     generic entropy-fallback label.
//   2. claude-paths — paths before emails. Filesystem paths may contain `@`
//                     segments; redacting/pseudonymizing the path first prevents
//                     the email rule from mis-tagging a path fragment as an email.
//   3. emails       — owner email is preserved here; all other emails are
//                     pseudonymized. Runs after paths so its input is already
//                     path-normalized.
//   4. entropy      — LAST: a catch-all for high-entropy blobs that no structured
//                     rule matched. It must run after everything else so it does
//                     not pre-empt a more specific category, and it deliberately
//                     skips already-emitted `<REDACTED:…>` spans.
export const RULES: readonly Rule[] = [
  secretsRule,
  claudePathsRule,
  emailsRule,
  entropyRule,
] as const;

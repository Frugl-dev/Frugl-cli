import type { RedactionCategory } from "../policy.js";
import type { Rule, RuleContext } from "./types.js";

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function redactEmails(
  input: string,
  ctx: RuleContext,
): { output: string; counts: Partial<Record<RedactionCategory, number>> } {
  const counts: Partial<Record<RedactionCategory, number>> = {};
  const lowerOwner = ctx.ownerEmail.toLowerCase();
  const output = input.replace(EMAIL_REGEX, (match) => {
    if (match.toLowerCase() === lowerOwner) return match;
    counts["third-party-email"] = (counts["third-party-email"] ?? 0) + 1;
    return ctx.pseudonyms.pseudonymize("third-party-email", match.toLowerCase());
  });
  return { output, counts };
}

export const emailsRule: Rule = {
  id: "emails",
  categories: ["third-party-email"],
  apply: (input, ctx) => redactEmails(input, ctx),
};

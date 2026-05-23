import type { RedactionCategory } from "../policy.js";

export interface SecretRedaction {
  category: RedactionCategory;
  match: string;
  replacement: string;
}

interface Pattern {
  category: RedactionCategory;
  regex: RegExp;
  replacement: (match: string) => string;
}

const PATTERNS: Pattern[] = [
  {
    category: "anthropic-key",
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: () => "<REDACTED:anthropic-key>",
  },
  {
    category: "openai-key",
    regex: /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    replacement: () => "<REDACTED:openai-key>",
  },
  {
    category: "aws-key",
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    replacement: () => "<REDACTED:aws-key>",
  },
  {
    category: "gcp-key",
    regex: /"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----[^"]+-----END PRIVATE KEY-----\\n?"/g,
    replacement: () => '"private_key": "<REDACTED:gcp-key>"',
  },
  {
    category: "github-token",
    regex: /\b(?:ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{20,}/g,
    replacement: () => "<REDACTED:github-token>",
  },
  {
    category: "slack-webhook",
    regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
    replacement: () => "<REDACTED:slack-webhook>",
  },
];

const ENV_LINE_REGEX = /\b([A-Z][A-Z0-9_]{2,})\s*=\s*([^\s"'\n#;]+)/g;

export function redactSecrets(input: string): {
  output: string;
  counts: Partial<Record<RedactionCategory, number>>;
} {
  const counts: Partial<Record<RedactionCategory, number>> = {};
  let output = input;
  for (const pattern of PATTERNS) {
    output = output.replace(pattern.regex, (match) => {
      counts[pattern.category] = (counts[pattern.category] ?? 0) + 1;
      return pattern.replacement(match);
    });
  }
  output = output.replace(ENV_LINE_REGEX, (_match, key: string, value: string) => {
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) return `${key}=`;
    counts["env-line"] = (counts["env-line"] ?? 0) + 1;
    return `${key}=<REDACTED:env-line>`;
  });
  return { output, counts };
}

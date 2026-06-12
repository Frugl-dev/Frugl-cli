import type { RedactionCategory } from "../policy.js";
import type { Rule } from "./types.js";

export interface SecretRedaction {
  category: RedactionCategory;
  match: string;
  replacement: string;
}

interface Pattern {
  category: RedactionCategory;
  regex: RegExp;
  replacement: (...groups: string[]) => string;
}

const PATTERNS: Pattern[] = [
  {
    category: "anthropic-key",
    regex: /(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: () => "<REDACTED:anthropic-key>",
  },
  {
    category: "openai-key",
    regex: /(?<![A-Za-z0-9_])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
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
    // Any PEM-armored private key block (RSA/EC/OPENSSH/PGP/…), whether the
    // body contains real newlines (catted key files) or escaped \n sequences
    // (keys embedded in JSON strings). Runs after gcp-key so the GCP JSON
    // shape keeps its precise label.
    category: "private-key",
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/g,
    replacement: () => "<REDACTED:private-key>",
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
  {
    // Both header and payload of a JWT start with base64url('{"…') = "eyJ".
    // The signature may be absent (alg "none"), so it is optional.
    category: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    replacement: () => "<REDACTED:jwt>",
  },
  {
    // URL userinfo passwords: postgres://user:PASS@host, redis://:PASS@host, …
    // Keeps scheme and username for debuggability; only the password goes.
    category: "connection-string",
    regex: /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]*):([^\s@/]+)@/g,
    replacement: (prefix) => `${prefix}:<REDACTED:connection-string>@`,
  },
  {
    // Authorization-style headers: Bearer / Basic / token values, in raw HTTP,
    // curl -H strings, or JSON header maps.
    category: "bearer-token",
    regex:
      /\b((?:Proxy-)?Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]+/gi,
    replacement: (prefix) => `${prefix}<REDACTED:bearer-token>`,
  },
  {
    // Stripe secret/restricted keys.
    category: "provider-token",
    regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replacement: () => "<REDACTED:provider-token>",
  },
  {
    // Slack bot/user/app/refresh tokens.
    category: "provider-token",
    regex: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
    replacement: () => "<REDACTED:provider-token>",
  },
  {
    // npm automation/publish tokens.
    category: "provider-token",
    regex: /\bnpm_[A-Za-z0-9]{28,}/g,
    replacement: () => "<REDACTED:provider-token>",
  },
  {
    // GitLab personal access tokens.
    category: "provider-token",
    regex: /\bglpat-[A-Za-z0-9_-]{20,}/g,
    replacement: () => "<REDACTED:provider-token>",
  },
];

// ALL-CAPS env assignments: KEY=value, KEY="value", KEY='value'. The quoted
// alternatives matter — .env files and `export FOO="…"` shell lines quote
// their values, and an unmatchable quote must not let the value through.
const ENV_LINE_REGEX = /\b([A-Z][A-Z0-9_]{2,})\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s"'\n#;]+)/g;

// Secret-named assignments in any case and any of the =/: separator styles
// (.env, shell, YAML, JSON, .ini): aws_secret_access_key = …, "apiKey": "…",
// passwd=…. The separator (with original quoting around the key) is preserved
// so JSON/YAML stay structurally recognizable.
const SECRET_ASSIGNMENT_REGEX =
  /\b((?:[A-Za-z_][A-Za-z0-9_-]*)?(?:key|token|secret|password|passwd|pwd|credentials?|auth))(["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi;

// Values that are clearly not secret material: booleans/null, short numbers,
// $VAR / ${VAR} references, and <placeholders> (including our own <REDACTED:…>
// markers — secrets patterns run before the assignment passes, and their
// output must not be double-counted under env-line).
const NON_SECRET_VALUE_REGEX =
  /^(?:true|false|null|none|undefined|\d{1,6}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>?)$/i;

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function redactSecrets(input: string): {
  output: string;
  counts: Partial<Record<RedactionCategory, number>>;
} {
  const counts: Partial<Record<RedactionCategory, number>> = {};
  let output = input;
  for (const pattern of PATTERNS) {
    output = output.replace(pattern.regex, (_match, ...args) => {
      counts[pattern.category] = (counts[pattern.category] ?? 0) + 1;
      const groups = args.slice(0, -2).filter((g): g is string => typeof g === "string");
      return pattern.replacement(...groups);
    });
  }
  output = output.replace(ENV_LINE_REGEX, (match, key: string, value: string) => {
    const inner = stripQuotes(value).trim();
    if (inner.length === 0) return `${key}=`;
    if (NON_SECRET_VALUE_REGEX.test(inner)) return match;
    counts["env-line"] = (counts["env-line"] ?? 0) + 1;
    return `${key}=<REDACTED:env-line>`;
  });
  output = output.replace(
    SECRET_ASSIGNMENT_REGEX,
    (match, key: string, sep: string, value: string) => {
      const inner = stripQuotes(value).trim();
      if (inner.length === 0) return match;
      if (NON_SECRET_VALUE_REGEX.test(inner)) return match;
      counts["env-line"] = (counts["env-line"] ?? 0) + 1;
      return `${key}${sep}<REDACTED:env-line>`;
    },
  );
  return { output, counts };
}

export const secretsRule: Rule = {
  id: "secrets",
  categories: [
    "anthropic-key",
    "openai-key",
    "aws-key",
    "gcp-key",
    "private-key",
    "github-token",
    "slack-webhook",
    "jwt",
    "connection-string",
    "bearer-token",
    "provider-token",
    "env-line",
  ],
  apply: (input) => redactSecrets(input),
};

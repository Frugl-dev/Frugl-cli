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

export const REDACTION_CATEGORIES: readonly RedactionCategory[] = [
  "anthropic-key",
  "openai-key",
  "aws-key",
  "gcp-key",
  "github-token",
  "slack-webhook",
  "env-line",
  "home-path",
  "project-name",
  "third-party-email",
  "entropy-fallback",
] as const;

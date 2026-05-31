// Pre-anonymization shapes for a Claude Code config snapshot — the configured/
// installed inventory the CLI assembles before scrubbing and upload (spec 026).
// Distinct from a *context* snapshot (025, what loads into the window): this is
// what is wired in at all, whether or not it ever loads or fires.

export type SourceParseStatus = "parsed" | "unparsed";

// A capture is assembled from four independent sources. Each can fail on its own
// (text-format drift in `claude` output, an unreadable settings layer) without
// sinking the others — Constitution Principle VI (honest failures).
export interface SourceResult<T> {
  items: T[];
  parseStatus: SourceParseStatus;
}

export type McpTransport = "http" | "stdio" | "unknown";
export type McpStatus = "connected" | "failed" | "pending" | "unknown";

export interface CapturedMcpServer {
  name: string;
  transport: McpTransport;
  // URL or launch command. Scrubbed of tokens/keys by the anonymizer before
  // upload; dropped entirely under --names-only.
  target: string;
  status: McpStatus;
}

export type PluginStatus = "enabled" | "disabled";

export interface CapturedPlugin {
  name: string;
  // "unknown" is preserved verbatim — `claude plugin list` reports it for some
  // plugins and we must not fabricate a version.
  version: string;
  scope: string;
  status: PluginStatus;
}

export interface CapturedHook {
  // Lifecycle event, e.g. "PreToolUse" / "PostToolUse" / "Stop".
  event: string;
  // Tool/pattern scope, or null when the entry has no matcher.
  matcher: string | null;
  // The command body. Scrubbed by the anonymizer; dropped under --names-only.
  command: string;
  // Originating layer/plugin, e.g. "user-settings" / "project-settings" /
  // "plugin:superpowers".
  source: string;
}

export type SkillAgentKind = "skill" | "slash_command" | "agent";

export interface CapturedSkillAgent {
  name: string;
  kind: SkillAgentKind;
  source: string;
}

export interface ConfigCapture {
  schemaVersion: 1;
  sourceTool: string; // "claude-code" in v1
  capturedAt: string; // ISO-8601 UTC
  hooks: SourceResult<CapturedHook>;
  mcpServers: SourceResult<CapturedMcpServer>;
  plugins: SourceResult<CapturedPlugin>;
  skillsAgents: SourceResult<CapturedSkillAgent>;
}

export function unparsedSource<T>(): SourceResult<T> {
  return { items: [], parseStatus: "unparsed" };
}

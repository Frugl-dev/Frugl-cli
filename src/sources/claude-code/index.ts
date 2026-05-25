import type { Source } from "../types.js";
import { CLAUDE_SOURCE_KIND, CLAUDE_FORMAT_VERSION, discoverClaudeSessions } from "./discover.js";
import { deriveClaudeIdentity } from "./identity.js";
import { parseClaudeSession } from "./parse.js";

export const claudeCodeSource: Source = {
  kind: CLAUDE_SOURCE_KIND,
  formatVersion: CLAUDE_FORMAT_VERSION,
  discover: async (opts) =>
    discoverClaudeSessions(opts?.homeDir !== undefined ? { homeDir: opts.homeDir } : undefined),
  parse: parseClaudeSession,
  deriveIdentity: (ref, parsed) => deriveClaudeIdentity(ref, parsed.records[0] ?? null),
};

export { CLAUDE_SOURCE_KIND, CLAUDE_FORMAT_VERSION } from "./discover.js";

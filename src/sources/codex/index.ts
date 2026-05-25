import type { Source } from "../types.js";
import { CODEX_SOURCE_KIND, CODEX_FORMAT_VERSION, discoverCodexSessions } from "./discover.js";
import { deriveCodexIdentity } from "./identity.js";
import { parseCodexSession } from "./parse.js";

export const codexSource: Source = {
  kind: CODEX_SOURCE_KIND,
  formatVersion: CODEX_FORMAT_VERSION,
  discover: async (opts) =>
    discoverCodexSessions(opts?.homeDir !== undefined ? { homeDir: opts.homeDir } : undefined),
  parse: parseCodexSession,
  deriveIdentity: (ref, parsed) => deriveCodexIdentity(ref, parsed.records[0] ?? null),
};

export { CODEX_SOURCE_KIND, CODEX_FORMAT_VERSION } from "./discover.js";

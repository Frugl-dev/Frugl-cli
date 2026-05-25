import type { Source } from "../types.js";
import { GEMINI_SOURCE_KIND, GEMINI_FORMAT_VERSION, discoverGeminiSessions } from "./discover.js";
import { deriveGeminiIdentity } from "./identity.js";
import { parseGeminiSession } from "./parse.js";

export const geminiSource: Source = {
  kind: GEMINI_SOURCE_KIND,
  formatVersion: GEMINI_FORMAT_VERSION,
  discover: async (opts) =>
    discoverGeminiSessions(opts?.homeDir !== undefined ? { homeDir: opts.homeDir } : undefined),
  parse: parseGeminiSession,
  deriveIdentity: (ref, parsed) => deriveGeminiIdentity(ref, parsed.records[0] ?? null),
};

export { GEMINI_SOURCE_KIND, GEMINI_FORMAT_VERSION } from "./discover.js";

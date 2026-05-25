import type { Source } from "../types.js";
import { CURSOR_SOURCE_KIND, CURSOR_FORMAT_VERSION, discoverCursorSessions } from "./discover.js";
import { deriveCursorIdentity } from "./identity.js";
import { parseCursorSession } from "./parse.js";

export const cursorSource: Source = {
  kind: CURSOR_SOURCE_KIND,
  formatVersion: CURSOR_FORMAT_VERSION,
  discover: async (opts) =>
    discoverCursorSessions(opts?.homeDir !== undefined ? { homeDir: opts.homeDir } : undefined),
  parse: parseCursorSession,
  deriveIdentity: (ref) => deriveCursorIdentity(ref),
};

export { CURSOR_SOURCE_KIND, CURSOR_FORMAT_VERSION } from "./discover.js";

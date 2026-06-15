import type { AuthSession } from "../auth/session.js";
import type { CloudClient } from "../cloud/client.js";
import type { OutputMode } from "../lib/output-mode.js";

// The runtime a snapshot runner needs: an authed cloud client, the resolved
// session (for the owner email the anonymizer keys on), and the output mode.
// Built once by the command (buildCommandContext) and shared by the context and
// mcp runners so a bare `frugl snapshot` runs both against one context.
export interface SnapshotRunContext {
  client: CloudClient;
  session: AuthSession;
  mode: OutputMode;
}

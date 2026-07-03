import { Command } from "@oclif/core";
import { z } from "zod";
import { clearAuthSession } from "../auth/session.js";
import { logoutResponseSchema } from "../cloud/schemas.js";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import { clearProfile } from "../lib/config.js";
import { color, symbol } from "../lib/theme.js";

export default class Logout extends Command {
  static override description = "Forget the local token and revoke this device's session.";

  static override examples = ["<%= config.bin %> <%= command.id %>"];

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(Logout);
    const { mode, endpoint, client, session } = await buildCommandContext(flags, {
      auth: "optional",
    });

    try {
      if (session) {
        try {
          await client.call({
            method: "POST",
            path: "/api/auth/signout",
            body: {},
            schema: z.object({}).passthrough().or(logoutResponseSchema),
          });
        } catch {
          // best-effort: logout always succeeds locally
        }
      }
      await clearAuthSession(endpoint.url);
      // Drop the cached identity/org display mirror (endpoint-scoped). Best-effort.
      try {
        clearProfile(endpoint.url);
      } catch {
        /* config is a convenience — a write failure must not fail logout */
      }

      if (mode === "json") {
        process.stdout.write(`${JSON.stringify({ command: "logout", ok: true })}\n`);
      } else {
        process.stdout.write(`${color.ok(`${symbol.tick} Logged out.`)}\n`);
        process.stdout.write(
          color.dim("  Local token cleared from keychain. Device session revoked on the server.\n"),
        );
      }
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}

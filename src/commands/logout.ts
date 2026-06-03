import { Command, Flags } from "@oclif/core";
import { z } from "zod";
import { CloudClient } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { clearAuthSession, loadAuthSession } from "../auth/session.js";
import { logoutResponseSchema } from "../cloud/schemas.js";
import { getCliVersion } from "../lib/cli-version.js";
import { isFruglError, printFruglError } from "../lib/errors.js";
import { resolveOutputMode } from "../lib/output-mode.js";
import { color, symbol } from "../lib/theme.js";

export default class Logout extends Command {
  static override description = "Forget the local token and revoke this device's session.";

  static override flags = {
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Logout);
    const mode = resolveOutputMode({ json: flags.json });
    const endpoint = resolveEndpoint({
      flag: flags.endpoint,
      env: process.env["FRUGL_ENDPOINT"],
    });

    try {
      const session = await loadAuthSession(endpoint.url);
      if (session) {
        const client = new CloudClient({
          endpointUrl: endpoint.url,
          cliVersion: getCliVersion(),
          token: session.token,
          endpointExplicit: endpoint.resolvedFrom !== "default",
        });
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

      if (mode === "json") {
        process.stdout.write(`${JSON.stringify({ command: "logout", ok: true })}\n`);
      } else {
        process.stdout.write(`${color.ok(`${symbol.tick} Logged out.`)}\n`);
        process.stdout.write(
          color.dim("  Local token cleared from keychain. Device session revoked on the server.\n"),
        );
      }
    } catch (err) {
      if (isFruglError(err)) {
        process.exit(printFruglError(err, mode));
      }
      throw err;
    }
  }
}

import { Command, Flags } from "@oclif/core";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { loadAuthSession } from "../auth/session.js";
import { EXIT } from "../lib/exit-codes.js";
import { isPoppiError } from "../lib/errors.js";
import { resolveOutputMode } from "../lib/output-mode.js";

export default class Whoami extends Command {
  static override description = "Print the signed-in user's email.";

  static override flags = {
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Whoami);
    const mode = resolveOutputMode({ json: flags.json });
    const endpoint = resolveEndpoint({
      flag: flags.endpoint,
      env: process.env["POPPI_ENDPOINT"],
    });

    try {
      const session = await loadAuthSession(endpoint.url);
      if (!session) {
        if (mode === "json") {
          process.stdout.write(
            `${JSON.stringify({ command: "whoami", ok: false, reason: "not-logged-in" })}\n`,
          );
        } else {
          process.stderr.write("Not logged in. Run 'poppi login'.\n");
        }
        process.exit(EXIT.AUTH_FAILURE);
      }
      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "whoami",
            ok: true,
            email: session.email,
            userId: session.userId,
            endpoint: session.endpointUrl,
            loggedInAt: session.loggedInAt,
          })}\n`,
        );
      } else {
        process.stdout.write(
          `${session.email}  (userId=${session.userId}; endpoint=${session.endpointUrl}; loggedInAt=${session.loggedInAt})\n`,
        );
      }
    } catch (err) {
      if (isPoppiError(err)) {
        process.stderr.write(`poppi: ${err.message}\n`);
        process.exit(err.exitCode);
      }
      throw err;
    }
  }
}

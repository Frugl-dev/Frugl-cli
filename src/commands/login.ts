import { Command, Flags } from "@oclif/core";
import { input, password } from "@inquirer/prompts";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { requestOtp, verifyOtp } from "../auth/otp-flow.js";
import { saveAuthSession } from "../auth/session.js";
import { isPoppiError } from "../lib/errors.js";
import { getCliVersion } from "../lib/cli-version.js";
import { resolveOutputMode } from "../lib/output-mode.js";
import { orgMeResponseSchema } from "../cloud/schemas.js";

export default class Login extends Command {
  static override description =
    "Sign in with an email one-time code; token persisted in OS keychain.";

  static override flags = {
    email: Flags.string({ description: "Email address to sign in with" }),
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Login);
    const mode = resolveOutputMode({ json: flags.json });
    const endpoint = resolveEndpoint({
      flag: flags.endpoint,
      env: process.env["POPPI_ENDPOINT"],
    });
    const client = new CloudClient({
      endpointUrl: endpoint.url,
      cliVersion: getCliVersion(),
      endpointExplicit: endpoint.resolvedFrom !== "default",
    });

    let email = flags.email;
    try {
      if (!email) {
        email = await input({
          message: "Email:",
          validate: (value) =>
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || "Enter a valid email address",
        });
      }
      await requestOtp(client, email);
      const code = await password({
        message: "6-digit code from email:",
        mask: "*",
        validate: (value) => /^\d{6}$/.test(value) || "Code must be 6 digits",
      });
      const session = await verifyOtp(client, email, code);
      await saveAuthSession(session);

      // Best-effort org check — warn immediately if the account has no org yet.
      // Errors other than 409 (network, timeout) are swallowed so they don't
      // block a successful login.
      let orgRequired = false;
      client.setToken(session.token);
      try {
        await client.call({ method: "GET", path: "/api/orgs/me", schema: orgMeResponseSchema });
      } catch (err) {
        if (err instanceof CloudHttpError && err.status === 409) {
          orgRequired = true;
        }
      }

      if (mode === "json") {
        const out: Record<string, unknown> = {
          command: "login",
          ok: true,
          email: session.email,
          endpoint: session.endpointUrl,
          userId: session.userId,
        };
        if (orgRequired) out["orgRequired"] = true;
        process.stdout.write(`${JSON.stringify(out)}\n`);
      } else {
        process.stdout.write(`Signed in as ${session.email} (endpoint: ${session.endpointUrl})\n`);
        if (orgRequired) {
          process.stderr.write(
            "poppi: No organization found. Run 'poppi setup' to finish setup.\n",
          );
        }
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

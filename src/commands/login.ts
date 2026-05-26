import { Command, Flags } from "@oclif/core";
import { input, password, select } from "@inquirer/prompts";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { requestOtp, verifyOtp } from "../auth/otp-flow.js";
import { saveAuthSession } from "../auth/session.js";
import { isPoppiError } from "../lib/errors.js";
import { getCliVersion } from "../lib/cli-version.js";
import { resolveOutputMode } from "../lib/output-mode.js";
import { orgMeResponseSchema } from "../cloud/schemas.js";
import { setupOrg, type OrgSetupAction } from "../org/setup.js";
import { deriveSlug } from "../org/slug.js";

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
      client.setToken(session.token);

      // Check whether the account already has an org.
      let orgRequired = false;
      try {
        await client.call({ method: "GET", path: "/api/orgs/me", schema: orgMeResponseSchema });
      } catch (err) {
        if (err instanceof CloudHttpError && err.status === 409) {
          orgRequired = true;
        } else {
          throw err;
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
        return;
      }

      process.stdout.write(`Signed in as ${session.email} (endpoint: ${session.endpointUrl})\n`);

      if (!orgRequired) return;

      // No org yet — run the org setup flow inline.
      process.stdout.write("\nYou don't have an organization yet. Set one up to continue.\n");

      let orgAction: OrgSetupAction;
      const choice = await select({
        message: "Organization setup:",
        choices: [
          { name: "Create a new organization", value: "create" },
          { name: "Join an existing organization with an invite code", value: "join" },
        ],
      });

      if (choice === "create") {
        const name = await input({
          message: "Organization name:",
          validate: (v) =>
            (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
        });
        orgAction = { action: "create", name, slug: deriveSlug(name) };
      } else {
        const inviteCode = await input({
          message: "Invite code:",
          validate: (v) => v.trim().length > 0 || "Enter an invite code",
        });
        orgAction = { action: "join", code: inviteCode.trim() };
      }

      // Retry loop for slug conflicts and invalid/expired invite codes.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const result = await setupOrg(client, orgAction);

        if (result.status === "already-setup" || result.status === "created" || result.status === "joined") {
          const label =
            result.status === "created"
              ? "Organization created"
              : result.status === "joined"
                ? "Joined organization"
                : "Organization";
          process.stdout.write(`${label}: ${result.orgName}\n`);
          return;
        }

        if (result.status === "slug-taken") {
          process.stderr.write(
            `poppi: That slug is already taken. Suggested alternative: ${result.suggestion}\n`,
          );
          // eslint-disable-next-line no-await-in-loop
          const name = await input({
            message: "Organization name (try a different one):",
            validate: (v) =>
              (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
          });
          orgAction = { action: "create", name, slug: deriveSlug(name) };
          continue;
        }

        if (result.status === "invalid-code") {
          process.stderr.write("poppi: Invite code not found. Check the code and try again.\n");
          // eslint-disable-next-line no-await-in-loop
          const inviteCode = await input({
            message: "Invite code:",
            validate: (v) => v.trim().length > 0 || "Enter an invite code",
          });
          orgAction = { action: "join", code: inviteCode.trim() };
          continue;
        }

        if (result.status === "expired-code") {
          process.stderr.write("poppi: That invite code has expired or been used up.\n");
          // eslint-disable-next-line no-await-in-loop
          const inviteCode = await input({
            message: "Invite code:",
            validate: (v) => v.trim().length > 0 || "Enter an invite code",
          });
          orgAction = { action: "join", code: inviteCode.trim() };
          continue;
        }
      }
    } catch (err) {
      if (isPoppiError(err)) {
        process.stderr.write(`poppi: ${err.message}\n`);
        process.exit(err.exitCode);
      }
      if (err instanceof CloudHttpError) {
        process.stderr.write(`poppi: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
  }
}

import { Command, Flags } from "@oclif/core";
import { input, password, select } from "@inquirer/prompts";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { requestOtp, verifyOtp } from "../auth/otp-flow.js";
import { loadAuthSession, saveAuthSession } from "../auth/session.js";
import { isPoppiError } from "../lib/errors.js";
import { getCliVersion } from "../lib/cli-version.js";
import { resolveOutputMode } from "../lib/output-mode.js";
import { setupOrg } from "../org/setup.js";
import { deriveSlug } from "../org/slug.js";

export default class Setup extends Command {
  static override description =
    "Authenticate and set up your organization in one step. Idempotent — safe to re-run.";

  static override flags = {
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    email: Flags.string({ description: "Email address to sign in with" }),
    "org-name": Flags.string({ description: "Organization name (skips interactive prompt)" }),
    "invite-code": Flags.string({ description: "Invite code to join an existing org" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Setup);
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

    try {
      // Step 1: Auth — reuse saved session or do OTP flow.
      let session = await loadAuthSession(endpoint.url);
      if (!session) {
        let email = flags.email;
        if (!email) {
          email = await input({
            message: "Email:",
            validate: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || "Enter a valid email address",
          });
        }
        await requestOtp(client, email);
        const code = await password({
          message: "6-digit code from email:",
          mask: "*",
          validate: (v) => /^\d{6}$/.test(v) || "Code must be 6 digits",
        });
        session = await verifyOtp(client, email, code);
        await saveAuthSession(session);
      }
      client.setToken(session.token);

      // Step 2: Org setup — interactive loop handles slug conflicts and bad codes.
      let orgAction: Parameters<typeof setupOrg>[1];

      if (flags["invite-code"]) {
        orgAction = { action: "join", code: flags["invite-code"] };
      } else if (flags["org-name"]) {
        const name = flags["org-name"];
        orgAction = { action: "create", name, slug: deriveSlug(name) };
      } else {
        const choice = await select({
          message: "Set up your organization:",
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
          const code = await input({
            message: "Invite code:",
            validate: (v) => v.trim().length > 0 || "Enter an invite code",
          });
          orgAction = { action: "join", code: code.trim() };
        }
      }

      // Retry loop: slug conflicts and invalid codes prompt the user to try again.
      // Each iteration awaits user input, so sequential awaits are intentional here.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const result = await setupOrg(client, orgAction);

        if (result.status === "already-setup") {
          this.emit_success(mode, session.email, result.orgName, result.slug, "existing");
          return;
        }
        if (result.status === "created") {
          this.emit_success(mode, session.email, result.orgName, result.slug, "created");
          return;
        }
        if (result.status === "joined") {
          this.emit_success(mode, session.email, result.orgName, result.slug, "joined");
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
          const code = await input({
            message: "Invite code:",
            validate: (v) => v.trim().length > 0 || "Enter an invite code",
          });
          orgAction = { action: "join", code: code.trim() };
          continue;
        }

        if (result.status === "expired-code") {
          process.stderr.write("poppi: That invite code has expired or been used up.\n");
          // eslint-disable-next-line no-await-in-loop
          const code = await input({
            message: "Invite code:",
            validate: (v) => v.trim().length > 0 || "Enter an invite code",
          });
          orgAction = { action: "join", code: code.trim() };
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

  private emit_success(
    mode: "text" | "json",
    email: string,
    orgName: string,
    slug: string,
    outcome: "existing" | "created" | "joined",
  ): void {
    if (mode === "json") {
      process.stdout.write(
        `${JSON.stringify({ command: "setup", ok: true, email, orgName, slug, outcome })}\n`,
      );
    } else {
      const label =
        outcome === "existing" ? "org" : outcome === "created" ? "org (created)" : "org (joined)";
      process.stdout.write(`Setup complete · ${email} · ${label}: ${orgName}\n`);
    }
  }
}

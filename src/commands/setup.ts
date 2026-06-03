import { Command, Flags } from "@oclif/core";
import { input, password, select } from "@inquirer/prompts";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { requestOtp, verifyOtp } from "../auth/otp-flow.js";
import { loadAuthSession, saveAuthSession } from "../auth/session.js";
import { isFruglError } from "../lib/errors.js";
import { getCliVersion } from "../lib/cli-version.js";
import { resolveOutputMode } from "../lib/output-mode.js";
import type { OrgSetupAction } from "../org/setup.js";
import { runOrgSetupFlow } from "../org/flow.js";
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
      env: process.env["FRUGL_ENDPOINT"],
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

      // Step 2: Org setup — the flow handles slug conflicts and bad codes.
      let orgAction: OrgSetupAction;

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

      // The flow handles slug conflicts and bad codes; each handler reprompts
      // for the field that failed, then the flow retries.
      const promptCode = async (): Promise<string> => {
        const code = await input({
          message: "Invite code:",
          validate: (v) => v.trim().length > 0 || "Enter an invite code",
        });
        return code.trim();
      };
      const result = await runOrgSetupFlow(client, orgAction, {
        onSlugTaken: async (suggestion) => {
          process.stderr.write(
            `frugl: That slug is already taken. Suggested alternative: ${suggestion}\n`,
          );
          return input({
            message: "Organization name (try a different one):",
            validate: (v) =>
              (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
          });
        },
        onInvalidCode: async () => {
          process.stderr.write("frugl: Invite code not found. Check the code and try again.\n");
          return promptCode();
        },
        onExpiredCode: async () => {
          process.stderr.write("frugl: That invite code has expired or been used up.\n");
          return promptCode();
        },
      });

      const outcome = result.status === "already-setup" ? "existing" : result.status;
      this.emit_success(mode, session.email, result.orgName, result.slug, outcome);
      return;
    } catch (err) {
      if (isFruglError(err)) {
        process.stderr.write(`frugl: ${err.message}\n`);
        process.exit(err.exitCode);
      }
      if (err instanceof CloudHttpError) {
        process.stderr.write(`frugl: ${err.message}\n`);
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

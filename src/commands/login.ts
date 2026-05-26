import { Command, Flags } from "@oclif/core";
import { input, password, select } from "@inquirer/prompts";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { requestOtp, verifyOtp } from "../auth/otp-flow.js";
import { clearAuthSession, saveAuthSession } from "../auth/session.js";
import { isPoppiError, printPoppiError } from "../lib/errors.js";
import { getCliVersion } from "../lib/cli-version.js";
import { resolveOutputMode } from "../lib/output-mode.js";
import { orgMeResponseSchema, type OrgMeResponse } from "../cloud/schemas.js";
import { setupOrg, type OrgSetupAction, type OrgSetupResult } from "../org/setup.js";
import { deriveSlug } from "../org/slug.js";
import { color, symbol } from "../lib/theme.js";

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
      let orgContext: OrgMeResponse | null = null;
      let orgRequired = false;
      try {
        orgContext = await client.call({
          method: "GET",
          path: "/api/orgs/me",
          schema: orgMeResponseSchema,
        });
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

      process.stdout.write(
        `${color.ok(`${symbol.tick} Signed in as ${session.email}`)}  ${color.dim(`(endpoint: ${session.endpointUrl})`)}\n`,
      );

      if (!orgRequired) {
        if (orgContext) {
          process.stdout.write(
            `${color.dim("  Active org: ")}${color.bold(orgContext.org.name)}  ${color.dim(`(role: ${orgContext.membership.role})`)}\n`,
          );
        }
        this.printNextSteps();
        return;
      }

      // No org yet — every Poppi account belongs to one. Offer the fork.
      process.stdout.write(
        `\n${color.bold("You're new here — every Poppi account belongs to an org.")}\n`,
      );
      process.stdout.write(
        color.dim(
          "An org is the team whose AI retros you share. You can be in more than one later.\n\n",
        ),
      );

      const choice = await select({
        message: "What would you like to do?",
        choices: [
          {
            name: "Create a new org",
            value: "create",
            description: "You become the owner. Invite teammates later.",
          },
          {
            name: "Join an existing org",
            value: "join",
            description: "Paste an invite code from a teammate.",
          },
          {
            name: "I'll decide later",
            value: "later",
            description: "Logs you in, but upload is blocked until you have one.",
          },
          {
            name: "Log out — wrong account",
            value: "logout",
            description: "Forget this token; you'll be back at poppi login.",
          },
        ],
      });

      if (choice === "later") {
        process.stdout.write(
          `\n${color.dim("  No problem. Set one up anytime with ")}${color.poppy("poppi org create")}${color.dim(" or ")}${color.poppy("poppi org join <code>")}${color.dim(".")}\n`,
        );
        process.stdout.write(color.dim("  Upload stays blocked until then.\n"));
        return;
      }

      if (choice === "logout") {
        await clearAuthSession(endpoint.url);
        process.stdout.write(
          `\n${color.ok(`${symbol.tick} Logged out.`)}  ${color.dim("Run ")}${color.poppy("poppi login")}${color.dim(" to sign in with a different account.")}\n`,
        );
        return;
      }

      let orgAction: OrgSetupAction;
      if (choice === "create") {
        const name = await input({
          message: "Org name:",
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

        if (
          result.status === "already-setup" ||
          result.status === "created" ||
          result.status === "joined"
        ) {
          this.printSetupSuccess(result);
          this.printNextSteps();
          return;
        }

        if (result.status === "slug-taken") {
          process.stderr.write(
            `${color.warn(`${symbol.warn} That slug is already taken.`)} ${color.dim(`Try: ${result.suggestion}\n`)}`,
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
          process.stderr.write(
            `${color.warn(`${symbol.warn} Invite code not found.`)} ${color.dim("Check the code and try again.")}\n`,
          );
          // eslint-disable-next-line no-await-in-loop
          const inviteCode = await input({
            message: "Invite code:",
            validate: (v) => v.trim().length > 0 || "Enter an invite code",
          });
          orgAction = { action: "join", code: inviteCode.trim() };
          continue;
        }

        if (result.status === "expired-code") {
          process.stderr.write(
            `${color.warn(`${symbol.warn} That invite code has expired or been used up.`)}\n`,
          );
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
        process.exit(printPoppiError(err, mode));
      }
      if (err instanceof CloudHttpError) {
        process.exit(printPoppiError(err, mode));
      }
      throw err;
    }
  }

  private printSetupSuccess(
    result: Extract<OrgSetupResult, { status: "created" | "joined" | "already-setup" }>,
  ): void {
    if (result.status === "created") {
      process.stdout.write(
        `\n${color.ok(`${symbol.tick} Org created.`)}  ${color.dim("You're the owner of ")}${color.bold(result.slug)}${color.dim(".")}\n`,
      );
    } else if (result.status === "joined") {
      process.stdout.write(
        `\n${color.ok(`${symbol.tick} Joined ${result.slug}`)}  ${color.dim("as member.")}\n`,
      );
    } else {
      process.stdout.write(
        `\n${color.ok(`${symbol.tick} Active org: ${result.orgName}`)}  ${color.dim(`(${result.slug})`)}\n`,
      );
    }
  }

  private printNextSteps(): void {
    process.stdout.write(`\n${color.dim("  Next:")}\n`);
    process.stdout.write(
      `${color.dim("    ")}${color.poppy("poppi upload --dry-run")}${color.dim("   preview what would be sent")}\n`,
    );
    process.stdout.write(
      `${color.dim("    ")}${color.poppy("poppi upload")}${color.dim("             anonymize + upload your first batch")}\n`,
    );
  }
}

import { Command, Flags } from "@oclif/core";
import { input, password, select } from "@inquirer/prompts";
import { CloudHttpError } from "../cloud/client.js";
import type { Endpoint } from "../cloud/endpoints.js";
import { AuthService } from "../auth/auth-service.js";
import { cloudIdentityClient } from "../auth/identity-client.js";
import { clearAuthSession } from "../auth/session.js";
import { getCliVersion } from "../lib/cli-version.js";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import type { OutputMode } from "../lib/output-mode.js";
import { orgMeResponseSchema, type OrgMeResponse } from "../cloud/schemas.js";
import type { OrgSetupAction } from "../org/setup.js";
import { runOrgSetupFlow } from "../org/flow.js";
import {
  makeOrgSetupPrompts,
  renderOrgSetupResult,
  type OrgSetupPresentation,
} from "../org/presenter.js";
import { deriveSlug } from "../org/slug.js";
import { color, symbol } from "../lib/theme.js";

export default class Login extends Command {
  static override description =
    "Sign in with an email one-time code; token persisted in OS keychain.";

  static override flags = {
    email: Flags.string({ description: "Email address to sign in with" }),
    token: Flags.string({
      description:
        "Store a pre-issued access token for non-interactive use (CI / hooks) instead of the email OTP flow.",
    }),
    ...COMMON_FLAGS,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Login);
    // "none": pre-auth, token-less client. We obtain the token mid-run (OTP or
    // the --token branch) and call client.setToken / persist it ourselves.
    const { mode, endpoint, client } = await buildCommandContext(flags, { auth: "none" });

    // Non-interactive: store a pre-issued access token (no OTP).
    if (flags.token) {
      await this.loginWithToken(flags.token, endpoint, mode);
      return;
    }

    // AuthService owns the OTP flow; `client` (from buildCommandContext) is the
    // token-less CloudClient reused for the post-login /api/orgs/me + org setup
    // flow, which is out of AuthService's scope.
    const auth = new AuthService({
      endpointUrl: endpoint.url,
      identity: cloudIdentityClient({
        endpointUrl: endpoint.url,
        endpointExplicit: endpoint.resolvedFrom !== "default",
        cliVersion: getCliVersion(),
      }),
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
      await auth.startLogin(email);
      const code = await password({
        message: "6-digit code from email:",
        mask: "*",
        validate: (value) => /^\d{6}$/.test(value) || "Code must be 6 digits",
      });
      const session = await auth.completeLogin(email, code);
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

      // No org yet — every Frugl account belongs to one. Offer the fork.
      process.stdout.write(
        `\n${color.bold("You're new here — every Frugl account belongs to an org.")}\n`,
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
            description: "Forget this token; you'll be back at frugl login.",
          },
        ],
      });

      if (choice === "later") {
        process.stdout.write(
          `\n${color.dim("  No problem. Set one up anytime with ")}${color.frog("frugl org create")}${color.dim(" or ")}${color.frog("frugl org join <code>")}${color.dim(".")}\n`,
        );
        process.stdout.write(color.dim("  Upload stays blocked until then.\n"));
        return;
      }

      if (choice === "logout") {
        await clearAuthSession(endpoint.url);
        process.stdout.write(
          `\n${color.ok(`${symbol.tick} Logged out.`)}  ${color.dim("Run ")}${color.frog("frugl login")}${color.dim(" to sign in with a different account.")}\n`,
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

      // The flow drives setup + slug-conflict / bad-code retries; each handler
      // reprompts for the field that failed. (This section is text-only — JSON
      // mode returned above before reaching the org fork, so the prompts and
      // rendering run in text mode.)
      const promptInviteCode = async (): Promise<string> => {
        const inviteCode = await input({
          message: "Invite code:",
          validate: (v) => v.trim().length > 0 || "Enter an invite code",
        });
        return inviteCode.trim();
      };
      const promptOrgName = (): Promise<string> =>
        input({
          message: "Organization name (try a different one):",
          validate: (v) =>
            (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
        });
      const orgSetupSpec: OrgSetupPresentation = {
        command: "login",
        reprompt: { name: promptOrgName, code: promptInviteCode },
        messages: {
          slugTaken: (suggestion) => ({
            warn: `${color.warn(`${symbol.warn} That slug is already taken.`)} ${color.dim(`Try: ${suggestion}`)}`,
            abort: `${color.warn(`${symbol.warn} That slug is already taken.`)} ${color.dim(`Try: ${suggestion}`)}`,
          }),
          invalidCode: {
            warn: `${color.warn(`${symbol.warn} Invite code not found.`)} ${color.dim("Check the code and try again.")}`,
            abort: `${color.warn(`${symbol.warn} Invite code not found.`)} ${color.dim("Check the code and try again.")}`,
          },
          expiredCode: {
            warn: `${color.warn(`${symbol.warn} That invite code has expired or been used up.`)}`,
            abort: `${color.warn(`${symbol.warn} That invite code has expired or been used up.`)}`,
          },
        },
        render: {
          text: (r) => {
            if (r.status === "created") {
              return `\n${color.ok(`${symbol.tick} Org created.`)}  ${color.dim("You're the owner of ")}${color.bold(r.slug)}${color.dim(".")}\n`;
            }
            if (r.status === "joined") {
              return `\n${color.ok(`${symbol.tick} Joined ${r.slug}`)}  ${color.dim("as member.")}\n`;
            }
            return `\n${color.ok(`${symbol.tick} Active org: ${r.orgName}`)}  ${color.dim(`(${r.slug})`)}\n`;
          },
          json: (r) => ({
            command: "login",
            ok: true,
            slug: r.slug,
            name: r.orgName,
            outcome:
              r.status === "already-setup"
                ? "existing"
                : r.status === "created"
                  ? "created"
                  : "joined",
          }),
        },
      };
      const result = await runOrgSetupFlow(
        client,
        orgAction,
        makeOrgSetupPrompts(orgSetupSpec, "text"),
      );
      renderOrgSetupResult(result, orgSetupSpec, "text");
      this.printNextSteps();
      return;
    } catch (err) {
      handleCommandError(err, mode);
    }
  }

  private async loginWithToken(token: string, endpoint: Endpoint, mode: OutputMode): Promise<void> {
    try {
      const auth = new AuthService({
        endpointUrl: endpoint.url,
        identity: cloudIdentityClient({
          endpointUrl: endpoint.url,
          endpointExplicit: endpoint.resolvedFrom !== "default",
          cliVersion: getCliVersion(),
        }),
      });
      const session = await auth.loginWithToken(token);

      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "login",
            ok: true,
            email: session.email,
            endpoint: session.endpointUrl,
            userId: session.userId,
            headless: true,
          })}\n`,
        );
        return;
      }
      process.stdout.write(
        `${color.ok(`${symbol.tick} Stored access token for ${session.email}`)}  ${color.dim(`(endpoint: ${session.endpointUrl})`)}\n`,
      );
    } catch (err) {
      handleCommandError(err, mode);
    }
  }

  private printNextSteps(): void {
    process.stdout.write(`\n${color.dim("  Next:")}\n`);
    process.stdout.write(
      `${color.dim("    ")}${color.frog("frugl upload --dry-run")}${color.dim("   preview what would be sent")}\n`,
    );
    process.stdout.write(
      `${color.dim("    ")}${color.frog("frugl upload")}${color.dim("             anonymize + upload your first batch")}\n`,
    );
  }
}

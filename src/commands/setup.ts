import { Command, Flags } from "@oclif/core";
import { input, password, select } from "@inquirer/prompts";
import { AuthService } from "../auth/auth-service.js";
import { cloudIdentityClient } from "../auth/identity-client.js";
import { getCliVersion } from "../lib/cli-version.js";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import type { OrgSetupAction } from "../org/setup.js";
import { runOrgSetupFlow } from "../org/flow.js";
import {
  makeOrgSetupPrompts,
  renderOrgSetupResult,
  type OrgSetupPresentation,
} from "../org/presenter.js";
import { deriveSlug } from "../org/slug.js";

export default class Setup extends Command {
  static override description =
    "Authenticate and set up your organization in one step. Idempotent — safe to re-run.";

  static override flags = {
    email: Flags.string({ description: "Email address to sign in with" }),
    "org-name": Flags.string({ description: "Organization name (skips interactive prompt)" }),
    "invite-code": Flags.string({ description: "Invite code to join an existing org" }),
    ...COMMON_FLAGS,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Setup);
    // "optional": reuse a saved session when present (client token pre-set);
    // otherwise session is null and we run the OTP flow + setToken below.
    const {
      mode,
      endpoint,
      client,
      session: existing,
    } = await buildCommandContext(flags, {
      auth: "optional",
    });

    // AuthService owns the OTP flow when there's no saved session.
    const auth = new AuthService({
      endpointUrl: endpoint.url,
      identity: cloudIdentityClient({
        endpointUrl: endpoint.url,
        endpointExplicit: endpoint.resolvedFrom !== "default",
        cliVersion: getCliVersion(),
      }),
    });

    try {
      // Step 1: Auth — reuse saved session or do OTP flow.
      let session = existing;
      if (!session) {
        let email = flags.email;
        if (!email) {
          email = await input({
            message: "Email:",
            validate: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || "Enter a valid email address",
          });
        }
        await auth.startLogin(email);
        const code = await password({
          message: "6-digit code from email:",
          mask: "*",
          validate: (v) => /^\d{6}$/.test(v) || "Code must be 6 digits",
        });
        session = await auth.completeLogin(email, code);
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
      // for the field that failed, then the flow retries. setup reprompts in
      // both modes (it has no pre-flow JSON guard), so the prompts are built in
      // text mode regardless of the output mode used for rendering.
      const promptCode = async (): Promise<string> => {
        const code = await input({
          message: "Invite code:",
          validate: (v) => v.trim().length > 0 || "Enter an invite code",
        });
        return code.trim();
      };
      const promptName = (): Promise<string> =>
        input({
          message: "Organization name (try a different one):",
          validate: (v) =>
            (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
        });
      const email = session.email;
      const label = (outcome: "existing" | "created" | "joined"): string =>
        outcome === "existing" ? "org" : outcome === "created" ? "org (created)" : "org (joined)";
      const spec: OrgSetupPresentation = {
        command: "setup",
        reprompt: { name: promptName, code: promptCode },
        messages: {
          slugTaken: (suggestion) => ({
            warn: `frugl: That slug is already taken. Suggested alternative: ${suggestion}`,
            abort: `frugl: That slug is already taken. Suggested alternative: ${suggestion}`,
          }),
          invalidCode: {
            warn: "frugl: Invite code not found. Check the code and try again.",
            abort: "frugl: Invite code not found. Check the code and try again.",
          },
          expiredCode: {
            warn: "frugl: That invite code has expired or been used up.",
            abort: "frugl: That invite code has expired or been used up.",
          },
        },
        render: {
          text: (r) => {
            const outcome = r.status === "already-setup" ? "existing" : r.status;
            return `Setup complete · ${email} · ${label(outcome)}: ${r.orgName}\n`;
          },
          json: (r) => ({
            command: "setup",
            ok: true,
            email,
            orgName: r.orgName,
            slug: r.slug,
            outcome: r.status === "already-setup" ? "existing" : r.status,
          }),
        },
      };

      const result = await runOrgSetupFlow(client, orgAction, makeOrgSetupPrompts(spec, "text"));
      renderOrgSetupResult(result, spec, mode);
      return;
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}

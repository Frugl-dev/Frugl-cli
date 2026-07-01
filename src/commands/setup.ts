import { Command, Flags } from "@oclif/core";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import { runAuthAndOrgSetup } from "../org/onboard.js";

function label(outcome: "existing" | "created" | "joined"): string {
  return outcome === "existing" ? "org" : outcome === "created" ? "org (created)" : "org (joined)";
}

export default class Setup extends Command {
  static override description =
    "Authenticate and set up your organization in one step. Idempotent — safe to re-run.";

  static override examples = [
    "<%= config.bin %> <%= command.id %>                                          # interactive: sign in, then create or join an org",
    '<%= config.bin %> <%= command.id %> --email you@team.com --org-name "Acme"   # non-interactive: sign in and create',
    "<%= config.bin %> <%= command.id %> --invite-code pop_inv_…                  # sign in and join with a teammate's code",
  ];

  static override flags = {
    email: Flags.string({ description: "Email address to sign in with" }),
    "org-name": Flags.string({ description: "Organization name (skips interactive prompt)" }),
    "invite-code": Flags.string({ description: "Invite code to join an existing org" }),
    ...COMMON_FLAGS,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Setup);
    // "optional": reuse a saved session when present (client token pre-set);
    // otherwise session is null and runAuthAndOrgSetup runs the OTP flow.
    const { mode, endpoint, client, session } = await buildCommandContext(flags, {
      auth: "optional",
    });

    try {
      // The auth + create/join flow now lives in one shared helper (FR-003).
      // `setup` pins reprompts to "default" — it always reprompts on a slug/code
      // conflict, even under --format json — keeping its pre-extraction behavior.
      const { session: authed, orgResult } = await runAuthAndOrgSetup({
        endpoint,
        client,
        mode,
        existingSession: session,
        flags: {
          email: flags.email,
          orgName: flags["org-name"],
          inviteCode: flags["invite-code"],
        },
        command: "setup",
        repromptMode: "default",
      });

      const email = authed.email;
      const outcome = orgResult.status === "already-setup" ? "existing" : orgResult.status;
      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "setup",
            ok: true,
            email,
            orgName: orgResult.orgName,
            slug: orgResult.slug,
            outcome,
          })}\n`,
        );
      } else {
        process.stdout.write(
          `Setup complete · ${email} · ${label(outcome)}: ${orgResult.orgName}\n`,
        );
      }
    } catch (err) {
      handleCommandError(err, mode);
    }
  }
}

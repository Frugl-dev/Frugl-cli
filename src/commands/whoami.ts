import { Command } from "@oclif/core";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { orgMeResponseSchema } from "../cloud/schemas.js";
import { EXIT } from "../lib/exit-codes.js";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import { color, symbol } from "../lib/theme.js";
import { recordProfileIdentity, recordProfileOrg } from "../lib/config.js";

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  memberCount?: number;
  role: string;
}

// "none" = the server confirmed no membership (409). "unknown" = the org lookup
// couldn't be completed (offline, transient error) — whoami still reports the
// local identity rather than failing over a supplementary lookup.
type OrgResult = OrgInfo | "none" | "unknown";

export default class Whoami extends Command {
  static override description = "Print the signed-in user's email and active org.";

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --format json   # scriptable identity check",
  ];

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(Whoami);
    const { mode, client, session } = await buildCommandContext(flags, { auth: "optional" });

    try {
      if (!session) {
        if (mode === "json") {
          process.stdout.write(
            `${JSON.stringify({ command: "whoami", ok: false, reason: "not-logged-in" })}\n`,
          );
        } else {
          process.stderr.write(`${color.err(`${symbol.cross} Not logged in.`)} `);
          process.stderr.write(
            `${color.dim("Run ")}${color.frog("frugl login")}${color.dim(" first.")}\n`,
          );
        }
        process.exit(EXIT.AUTH_FAILURE);
      }

      const org = await this.resolveOrg(client);
      const orgInfo = typeof org === "string" ? null : org;

      // Refresh the non-secret profile cache so `frugl config` can show this
      // identity + org without a keychain read or a cloud call. Best-effort; a
      // cache write must never fail whoami. "unknown" (couldn't reach the cloud)
      // leaves any previously-cached org untouched.
      try {
        recordProfileIdentity({
          endpoint: session.endpointUrl,
          email: session.email,
          userId: session.userId,
          loggedInAt: session.loggedInAt,
        });
        if (orgInfo) {
          recordProfileOrg(session.endpointUrl, {
            slug: orgInfo.slug,
            name: orgInfo.name,
            role: orgInfo.role,
          });
        } else if (org === "none") {
          recordProfileOrg(session.endpointUrl, null);
        }
      } catch {
        /* ignore — the profile cache is a convenience, not a contract */
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
            organization: orgInfo
              ? {
                  id: orgInfo.id,
                  name: orgInfo.name,
                  slug: orgInfo.slug,
                  ...(orgInfo.memberCount !== undefined
                    ? { member_count: orgInfo.memberCount }
                    : {}),
                  role: orgInfo.role,
                }
              : null,
          })}\n`,
        );
        return;
      }

      const orgSegment = orgInfo
        ? `${color.dim(" · org=")}${color.bold(orgInfo.slug)}${color.dim(` · role=${orgInfo.role}`)}`
        : org === "none"
          ? color.dim(" · no org yet")
          : "";
      process.stdout.write(
        `${color.bold(session.email)}${orgSegment}${color.dim(` · endpoint=${session.endpointUrl}`)}\n`,
      );
      if (org === "none") {
        process.stdout.write(
          `${color.dim("             Set one up: ")}${color.frog("frugl org create")}${color.dim(" or ")}${color.frog("frugl org join <code>")}\n`,
        );
      } else {
        process.stdout.write(
          color.dim(`             loggedInAt=${session.loggedInAt}   userId=${session.userId}\n`),
        );
      }
    } catch (err) {
      handleCommandError(err, mode);
    }
  }

  // GET /api/orgs/me → org context, best-effort. 409 is "signed in, no org"
  // (a reported state). Any other failure leaves the org "unknown" so whoami
  // still prints the local identity instead of failing over a side lookup.
  private async resolveOrg(client: CloudClient): Promise<OrgResult> {
    try {
      const me = await client.call({
        method: "GET",
        path: "/api/orgs/me",
        schema: orgMeResponseSchema,
      });
      return {
        id: me.org.id,
        name: me.org.name,
        slug: me.org.slug,
        ...(me.org.member_count !== undefined ? { memberCount: me.org.member_count } : {}),
        role: me.membership.role,
      };
    } catch (err) {
      if (err instanceof CloudHttpError && err.status === 409) return "none";
      return "unknown";
    }
  }
}

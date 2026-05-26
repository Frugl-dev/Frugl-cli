import { Command, Flags } from "@oclif/core";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint } from "../cloud/endpoints.js";
import { loadAuthSession } from "../auth/session.js";
import { orgMeResponseSchema } from "../cloud/schemas.js";
import { getCliVersion } from "../lib/cli-version.js";
import { EXIT } from "../lib/exit-codes.js";
import { isPoppiError, printPoppiError } from "../lib/errors.js";
import { resolveOutputMode } from "../lib/output-mode.js";
import { color, symbol } from "../lib/theme.js";

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
          process.stderr.write(`${color.err(`${symbol.cross} Not logged in.`)} `);
          process.stderr.write(
            `${color.dim("Run ")}${color.poppy("poppi login")}${color.dim(" first.")}\n`,
          );
        }
        process.exit(EXIT.AUTH_FAILURE);
      }

      const client = new CloudClient({
        endpointUrl: endpoint.url,
        cliVersion: getCliVersion(),
        token: session.token,
        endpointExplicit: endpoint.resolvedFrom !== "default",
      });
      const org = await this.resolveOrg(client);
      const orgInfo = typeof org === "string" ? null : org;

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
          `${color.dim("             Set one up: ")}${color.poppy("poppi org create")}${color.dim(" or ")}${color.poppy("poppi org join <code>")}\n`,
        );
      } else {
        process.stdout.write(
          color.dim(`             loggedInAt=${session.loggedInAt}   userId=${session.userId}\n`),
        );
      }
    } catch (err) {
      if (isPoppiError(err) || err instanceof CloudHttpError) {
        process.exit(printPoppiError(err, mode));
      }
      throw err;
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

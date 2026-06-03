import { EXIT } from "../lib/exit-codes.js";
import { resolveOutputMode, type OutputModeFlags } from "../lib/output-mode.js";
import { handleCommandError } from "../lib/command-context.js";
import { authedClient, fetchOrgContext } from "./runtime.js";
import { renderNoOrg, renderOrgTable } from "./render.js";

export interface OrgListFlags extends OutputModeFlags {
  endpoint?: string | undefined;
}

// Shared body for `frugl org` and `frugl org ls`. The backend models a single
// active org per account (GET /api/orgs/me), so the table has one row today;
// 409 is reported as "no org" at exit 0, not a failure.
export async function runOrgList(flags: OrgListFlags): Promise<never> {
  const mode = resolveOutputMode(flags);
  try {
    const { client, session } = await authedClient(flags.endpoint);
    const ctx = await fetchOrgContext(client);

    if (mode === "json") {
      const organizations =
        ctx.kind === "member"
          ? [
              {
                slug: ctx.slug,
                name: ctx.name,
                role: ctx.role,
                ...(ctx.memberCount !== undefined ? { member_count: ctx.memberCount } : {}),
                active: true,
              },
            ]
          : [];
      process.stdout.write(
        `${JSON.stringify({
          command: "org",
          ok: true,
          activeSlug: ctx.kind === "member" ? ctx.slug : null,
          organizations,
        })}\n`,
      );
      process.exit(EXIT.OK);
    }

    if (ctx.kind === "none") {
      process.stdout.write(`${renderNoOrg(session.email)}\n`);
      process.exit(EXIT.OK);
    }

    process.stdout.write(
      `${renderOrgTable([
        {
          slug: ctx.slug,
          role: ctx.role,
          ...(ctx.memberCount !== undefined ? { memberCount: ctx.memberCount } : {}),
          active: true,
        },
      ])}\n`,
    );
    process.exit(EXIT.OK);
  } catch (err) {
    handleCommandError(err, mode);
  }
}

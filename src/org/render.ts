import { color, symbol } from "../lib/theme.js";

export interface OrgRow {
  slug: string;
  role: string;
  memberCount?: number;
  active: boolean;
}

// The `org ls` table — SLUG / ROLE / MEMBERS / ACTIVE, with a frugl-green dot
// marking the active org. Columns are padded on the plain text before coloring
// so the (zero-width) color codes never disturb alignment.
const COL = { role: 9, members: 10 };
// The slug column sizes to the widest slug (+ gutter) so a long slug can't run
// into ROLE; MIN keeps the established layout when every slug is short.
const SLUG_MIN = 14;
const SLUG_GUTTER = 2;

export function renderOrgTable(rows: OrgRow[]): string {
  const slugCol = Math.max(SLUG_MIN, ...rows.map((r) => r.slug.length + SLUG_GUTTER));
  const lines: string[] = [];
  lines.push(
    `  ${color.mute(
      "SLUG".padEnd(slugCol) + "ROLE".padEnd(COL.role) + "MEMBERS".padEnd(COL.members) + "ACTIVE",
    )}`,
  );
  for (const row of rows) {
    const members = row.memberCount !== undefined ? String(row.memberCount) : "—";
    lines.push(
      `  ${color.bold(row.slug.padEnd(slugCol))}${color.dim(row.role.padEnd(COL.role))}` +
        `${members.padEnd(COL.members)}${row.active ? symbol.activeDot : ""}`,
    );
  }
  return lines.join("\n");
}

// Shown when the signed-in account belongs to no org — a reported state, with
// both remedies. Mirrors the design's "signed in but no org" copy.
export function renderNoOrg(email?: string): string {
  const lines: string[] = [];
  lines.push(color.bold("You're not in any org yet."));
  lines.push(color.dim("  Every Frugl account belongs to an org. Pick one:"));
  lines.push("");
  lines.push(
    `    ${color.frog("frugl org create")}        ${color.dim("start a new org (you become owner)")}`,
  );
  lines.push(
    `    ${color.frog("frugl org join <code>")}   ${color.dim("accept an invite from a teammate")}`,
  );
  if (email) {
    lines.push("");
    lines.push(color.dim(`  Signed in as ${email}.`));
  }
  return lines.join("\n");
}

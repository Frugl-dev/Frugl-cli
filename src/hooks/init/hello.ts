import { Hook } from "@oclif/core";
import { resolveEndpoint } from "../../cloud/endpoints.js";
import { loadAuthSession } from "../../auth/session.js";
import { color, SIGIL } from "../../lib/theme.js";

// The first-run / no-args landing — the frog says hi, the tagline reminds you
// what frugl is for, and the three most-used commands sit one keystroke away.
//
// Implemented as an init hook (not a `commands/index.ts`, which would make oclif
// treat this as a single-command CLI). It fires ONLY on a truly bare `frugl`
// invocation; any command id or flag (--help, --version) passes straight
// through. Local-only — a keychain read for the signed-in line — so it stays
// instant and works offline.
const hook: Hook<"init"> = async function (opts) {
  if (opts.id !== undefined || opts.argv.length > 0) return;

  const endpoint = resolveEndpoint({ flag: undefined, env: process.env["FRUGL_ENDPOINT"] });
  const session = await loadAuthSession(endpoint.url).catch(() => null);
  const version = opts.config.version;

  const out = process.stdout;
  // Command name padded to a fixed column so the descriptions line up.
  const row = (name: string, desc: string): void => {
    out.write(`    ${color.frog(name)}${" ".repeat(Math.max(1, 11 - name.length))}${desc}\n`);
  };

  out.write("\n");
  out.write(
    `  ${color.frog(SIGIL)}   ${color.bold("frugl")}  ${color.dim("·")}  ${color.mute(version)}\n`,
  );
  out.write(`          ${color.dim("the receipts for your team's AI spend.")}\n`);
  if (session) {
    out.write(`          ${color.dim("Signed in as ")}${color.bold(session.email)}\n`);
  } else {
    out.write(
      `          ${color.dim("Not signed in yet — run ")}${color.frog("frugl login")}${color.dim(" to start.")}\n`,
    );
  }
  out.write("\n");
  out.write(`  ${color.mute("USED MOST")}\n`);
  row(
    "upload",
    `${color.dim("anonymize on your machine, ")}${color.bold("then")}${color.dim(" send.")}`,
  );
  row("recs", color.dim("what's worth fixing this week — ranked by $/mo."));
  row("snapshot", color.dim("capture your context window + MCP servers."));
  out.write("\n");
  out.write(
    `  ${color.dim("First time? ")}${color.frog("frugl upload --dry-run")}${color.dim(" shows everything, sends nothing.")}\n`,
  );
  out.write(
    `  ${color.dim("All commands: ")}${color.frog("frugl --help")}${color.dim("   ·   Stay green.")}\n`,
  );
  out.write("\n");

  // Bare landing screen — nothing ran, so exit clean before oclif prints help.
  process.exit(0);
};

export default hook;

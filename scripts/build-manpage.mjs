#!/usr/bin/env node
// Generate man/frugl.1 from the oclif manifest so the man page can never drift
// from the actual command surface — descriptions, flags, args, and examples all
// come from the same command classes that power `frugl --help`.
//
// Run after `oclif manifest` (see the `build` script). The output is gitignored
// and regenerated on every build; it ships in the npm tarball via the package
// `files` + `man` fields, so `man frugl` works after `npm install -g frugl`.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "oclif.manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const BIN = pkg.oclif?.bin ?? "frugl";
const VERSION = manifest.version ?? pkg.version;
const DATE = new Date().toISOString().slice(0, 10);

// Escape text for a roff body: backslashes first, then literal hyphens (so flag
// names like --dry-run aren't hyphenated or mangled), and guard a leading dot or
// apostrophe (which roff would read as a control line).
function roff(text) {
  let s = String(text).replace(/\\/g, "\\\\").replace(/-/g, "\\-");
  if (/^[.']/.test(s)) s = `\\&${s}`;
  return s;
}

// oclif example templating → concrete command text.
function expandExample(ex, id) {
  return String(ex)
    .replaceAll("<%= config.bin %>", BIN)
    .replaceAll("<%= command.id %>", id.replaceAll(":", " "));
}

// One flag rendered as its invocation form, e.g. `--min-cost=<value>` or
// `--[no-]handoff` or `-y, --yes`.
function flagForm(flag) {
  const dashName = flag.allowNo ? `--[no-]${flag.name}` : `--${flag.name}`;
  const lead = flag.char ? `-${flag.char}, ${dashName}` : dashName;
  if (flag.type === "boolean") return lead;
  const value = flag.helpValue ?? (flag.options ? flag.options.join("|") : "<value>");
  return `${lead}=${value}`;
}

const out = [];
const line = (s = "") => out.push(s);

// ── Header ────────────────────────────────────────────────────────────────
line(`.TH FRUGL 1 "${DATE}" "${BIN} ${VERSION}" "Frugl Manual"`);

line(".SH NAME");
line(`${roff(BIN)} \\- ${roff(pkg.description)}`);

line(".SH SYNOPSIS");
line(`.B ${BIN}`);
line("[\\fICOMMAND\\fR]");
line("[\\fIFLAGS\\fR]");

line(".SH DESCRIPTION");
line(
  roff(
    "Frugl reads the session logs your AI coding assistants already write to disk, " +
      "anonymizes them locally, and uploads them to hosted Frugl for retrospective " +
      "waste analysis — so you can see where your team is burning tokens.",
  ),
);
line(".PP");
line(
  roff(
    "The anonymizer runs locally, before any byte is transmitted, and it fails " +
      "closed: if redaction cannot complete, nothing is uploaded.",
  ),
);
line(".PP");
line(
  `Every command accepts ${roff("--format")} to control output and ${roff("--help")} for its full flag list.`,
);

// ── Commands ──────────────────────────────────────────────────────────────
// Top-level topics first (login, upload, …) then nested, both alphabetical, so
// the page reads in the same order as `frugl --help`.
const commands = Object.values(manifest.commands)
  .filter((c) => !c.hidden)
  .toSorted((a, b) => a.id.localeCompare(b.id));

line(".SH COMMANDS");
for (const cmd of commands) {
  const spacedId = cmd.id.replaceAll(":", " ");
  const args = Object.values(cmd.args ?? {});
  const argSig = args.map((a) => (a.required ? `<${a.name}>` : `[<${a.name}>]`)).join(" ");
  const heading = `${BIN} ${spacedId}${argSig ? ` ${argSig}` : ""}`;
  line(`.SS ${roff(heading)}`);

  // Description: keep the first paragraph as prose; render any pre-aligned block
  // (the "Exit codes:" lists) verbatim inside a no-fill region so columns hold.
  const desc = String(cmd.description ?? "").trim();
  renderDescription(desc);

  const aliases = (cmd.aliases ?? []).filter(Boolean);
  if (aliases.length > 0) {
    line(".PP");
    line(`Aliases: ${aliases.map((a) => roff(`${BIN} ${a.replaceAll(":", " ")}`)).join(", ")}`);
  }

  if (args.length > 0) {
    line(".PP");
    line("Arguments:");
    for (const a of args) {
      line(".TP");
      line(`.B ${roff(a.name)}`);
      line(roff(a.description ?? (a.required ? "Required." : "Optional.")));
    }
  }

  const flags = Object.values(cmd.flags ?? {})
    .filter((f) => !f.hidden)
    .toSorted((a, b) => a.name.localeCompare(b.name));
  if (flags.length > 0) {
    line(".PP");
    line("Flags:");
    for (const f of flags) {
      line(".TP");
      line(`.B ${roff(flagForm(f))}`);
      const extra = f.default !== undefined ? ` (default: ${f.default})` : "";
      line(roff(`${f.description ?? ""}${extra}`.trim() || "—"));
    }
  }

  const examples = (cmd.examples ?? []).map((e) =>
    expandExample(typeof e === "string" ? e : e.command, cmd.id),
  );
  if (examples.length > 0) {
    line(".PP");
    line("Examples:");
    line(".nf");
    line(".RS");
    for (const ex of examples) line(roff(ex));
    line(".RE");
    line(".fi");
  }
}

// ── Trailer ───────────────────────────────────────────────────────────────
line(".SH EXIT STATUS");
line(
  roff(
    "0 success · 2 usage error · 10 not authenticated · 11 OS keychain unavailable · " +
      "20 no sessions found · 30 anonymization failure · 40 network error · " +
      "41 endpoint unreachable · 50 CLI version outdated.",
  ),
);
line(".PP");
line(
  roff(
    "Per-command exit codes are listed in each command's --help and in the COMMANDS section above.",
  ),
);

line(".SH ENVIRONMENT");
line(".TP");
line(".B FRUGL_ENDPOINT");
line(roff("Override the API endpoint (also settable per-run with --endpoint)."));
line(".TP");
line(".B FRUGL_TOKEN");
line(roff("Access token for non-interactive auth (CI / hooks)."));
line(".TP");
line(".B FRUGL_HOME_DIR");
line(roff("Override where Frugl looks for AI-tool session logs."));
line(".TP");
line(".B FRUGL_DEBUG");
line(roff("Set to 1 to print HTTP request/response lines to stderr."));

line(".SH FILES");
line(roff("Sessions are discovered from each tool's default location, e.g. ~/.claude/projects."));

line(".SH SEE ALSO");
line(roff(`Project homepage: ${pkg.homepage ?? "https://frugl.dev"}`));
line(".br");
line(roff(`Report bugs: ${pkg.bugs?.url ?? "https://github.com/Frugl-dev/Frugl-cli/issues"}`));

line(".SH AUTHOR");
line(roff(pkg.author ?? "Frugl"));

mkdirSync(path.join(root, "man"), { recursive: true });
writeFileSync(path.join(root, "man", "frugl.1"), `${out.join("\n")}\n`, { flag: "w" });

// Split a command description into prose paragraphs and verbatim blocks. A line
// like "Exit codes:" introduces an indented list whose alignment we preserve.
function renderDescription(desc) {
  if (!desc) return;
  const lines = desc.split("\n");
  let i = 0;
  let pendingBlank = false;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "") {
      pendingBlank = true;
      i += 1;
      continue;
    }
    // An indented run (leading whitespace) is a pre-aligned block — emit it
    // verbatim so columns like the exit-code table survive.
    if (/^\s+\S/.test(raw)) {
      line(".nf");
      while (i < lines.length && (lines[i].trim() === "" || /^\s+\S/.test(lines[i]))) {
        line(roff(lines[i]));
        i += 1;
      }
      line(".fi");
      pendingBlank = false;
      continue;
    }
    if (pendingBlank) {
      line(".PP");
      pendingBlank = false;
    }
    line(roff(trimmed));
    i += 1;
  }
}

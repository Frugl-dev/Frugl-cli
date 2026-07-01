<div align="center">
  <img src="./brand/frugl-icon.svg" alt="Frugl" width="92" height="92" />

# `frugl` — the Frugl CLI

**Find the waste in your AI coding sessions — without your code ever leaving your machine.**

[Website](https://frugl.dev) · [Dashboard](https://app.frugl.dev) · [Report a bug](https://github.com/Frugl-dev/Frugl-cli/issues)

</div>

---

Frugl reads the session logs your AI coding assistants already write to disk
(Claude Code today; Codex, Cursor, and Gemini detected and coming soon),
**anonymizes them locally**, and uploads them to [hosted Frugl](https://app.frugl.dev)
for retrospective waste analysis. The dashboard shows where your team is burning
tokens — "you reload the same 40k-token file every session," "this agent loops on
a failing test" — so you can spend fewer tokens getting the same work done.

The catch every team worries about: _your raw prompts and code never leave your
machine._ The anonymizer runs **locally, before any byte is transmitted**, and it
[**fails closed**](#why-open-source) — if redaction can't complete, nothing uploads.
That's also why this CLI is open source: you can read exactly what it does to your
data before you trust it with any.

## Quick start

```bash
npm install -g frugl                 # or run ad-hoc with: npx frugl <command>

frugl login                          # sign in (GitHub, Google, or email code)
                                     #   first-time accounts are walked through
                                     #   creating or joining an org, right here
frugl upload                         # discover, anonymize, and upload your sessions
```

Then open the dashboard link the upload prints to see where your team is
burning tokens. Everything below is the detail.

## Commands

| Command              | What it does                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `frugl setup`        | Authenticate **and** create/join an org in one idempotent step. Safe to re-run.                |
| `frugl login`        | Sign in (GitHub, Google, or email code); first-time accounts are set up with an org too.       |
| `frugl logout`       | Revoke this device's session and forget the local token.                                       |
| `frugl whoami`       | Show the signed-in identity, active org, and role.                                             |
| `frugl upload`       | Discover, anonymize, and upload local AI-coding sessions.                                      |
| `frugl snapshot`     | Capture + upload both snapshots (context window + MCP servers). Subcommands: `context`, `mcp`. |
| `frugl org`          | Manage your org (`create`, `join`, `use`, `invites`, `ls`).                                    |
| `frugl hook install` | Auto-upload from a Claude Code hook when a session ends.                                       |

Every command supports `--format` to control output, and `--help` (or `-h`) for
the full flag list. `frugl help <command>` does the same, and `man frugl` opens
the complete manual offline. The formats are:

| `--format` | For                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `default`  | Humans at an interactive terminal — colored, with hints and progress. The default.              |
| `json`     | Scripts and pipelines — one machine-readable JSON object (or NDJSON stream) per result.         |
| `minimal`  | Agents and CI logs — the same facts as `default` but plain text: no color, mascot, or spinners. |

When `--format` is omitted, Frugl picks `minimal` if it detects CI (the `CI`
env var or a known provider) and `default` otherwise.

## Guided upload

In an interactive terminal, `frugl upload` walks you through what it found
before sending anything:

1. **Providers** — it detects which AI assistants have sessions on this machine
   (Claude Code, Codex, Cursor, Gemini) and shows them as preselected dots.
   Claude Code is uploaded today; Codex/Cursor/Gemini show as detected but
   `(not yet supported)` and are skipped.
2. **Projects** — it lists the projects it discovered, all preselected. Deselect
   any you don't want to upload (a scratch dir, a client repo under NDA, …).
3. **Upload** — only the sessions you kept selected are anonymized and uploaded.

By default trivial sessions (negligible estimated cost) are filtered out
automatically; use `--min-cost` to raise that threshold.

```bash
frugl upload                               # discover, anonymize, and upload AI coding sessions
frugl upload sessions                      # same, named explicitly
frugl upload --dry-run                     # discover + anonymize; transmit zero bytes
frugl upload --yes                         # upload without the confirmation prompt
frugl upload --min-cost 25                 # skip sessions estimated under $25 (floor is $10)
frugl upload --limit 20                    # cap how many sessions upload
frugl upload --report                      # explain the last upload's failures
```

Non-interactive runs (`--yes`, `--format json`/`--format minimal`,
or no TTY such as CI) skip the prompts and select every detected supported
provider and all of its projects automatically.

After a successful upload, the printed dashboard link carries a **single-use,
~60-second sign-in code** (`?handoff=…`) so opening it lands you on your
dashboard already signed in — no second login. The code is **not** your CLI
token, dies on first use or expiry, and is **off by default in non-interactive
runs** (CI, pipes, `--format json`/`minimal`); pass `--handoff` to opt in there, or `--no-handoff`
to keep it out of any printed output (shared or recorded terminals). If the link
has expired, the web login returns you to the same dashboard page afterwards.

## Project config (`.frugl.json`)

Commit a `.frugl.json` at the root of a repo to lock in upload and snapshot
settings for everyone who works there — no flags, no prompts, no per-developer
setup beyond `frugl login`.

```json
{
  "$schema": "https://app.frugl.dev/schema/frugl.v1.json",
  "version": 1,
  "org": "acme",
  "upload": {
    "auto": true
  }
}
```

Run `frugl init` to create this file interactively (auth → org → first upload →
snapshot, all in one step).

### `upload.auto`

Set to `true` to make `frugl upload` fully non-interactive — equivalent to
always passing `--yes`. When active:

- Sessions are scanned **only in the repo containing the `.frugl.json`**, not
  across the whole machine. The nearest config file wins when configs are nested.
- Provider and project selection prompts are skipped entirely.
- A snapshot runs automatically after the upload completes.

```json
{ "upload": { "auto": true } }
```

### `upload.providers`

Restrict which AI providers are scanned. Omit the key to include all
supported providers (the default); set it to limit to a specific subset.

```json
{ "upload": { "auto": true, "providers": ["claude-code"] } }
```

Supported provider ids: `claude-code`, `codex`, `cursor`, `gemini`.

### `upload.enabled` / `snapshot.enabled`

Set either to `false` to disable that command for this repo. `frugl upload`
or `frugl snapshot` will exit immediately with a clear message rather than
uploading anything. Both default to `true` and are omitted from the file
when not explicitly set.

```json
{
  "upload": { "enabled": false },
  "snapshot": { "enabled": false }
}
```

### Full reference

| Key                  | Type     | Default | Effect                                                                         |
| -------------------- | -------- | ------- | ------------------------------------------------------------------------------ |
| `org`                | string   | —       | Org slug to upload to. Set by `frugl init`.                                    |
| `upload.auto`        | boolean  | `false` | Non-interactive mode: skip all prompts, scope to this repo, auto-run snapshot. |
| `upload.enabled`     | boolean  | `true`  | Set to `false` to disable `frugl upload` for this repo.                        |
| `upload.providers`   | string[] | all     | Restrict which providers are scanned. Omit for all supported.                  |
| `upload.minCost`     | number   | `10`    | Skip sessions whose estimated cost is below this USD amount.                   |
| `upload.concurrency` | number   | `4`     | Per-session upload concurrency.                                                |
| `upload.linkPrs`     | boolean  | `false` | Attach credential-stripped git context so sessions link to PRs.                |
| `snapshot.enabled`   | boolean  | `true`  | Set to `false` to disable `frugl snapshot` for this repo.                      |

Keys equal to their default are omitted when the file is written. The schema
is validated on every read — a typo (e.g. `uplaod`) is a hard error, not a
silent no-op.

## Continuous uploads (Claude Code hook)

Don't want to remember to run `frugl upload`? Install a Claude Code hook that
fires a headless upload every time a session ends:

```bash
frugl hook install            # writes ./.claude/settings.json (this project)
frugl hook install --global   # writes ~/.claude/settings.json (everywhere)
frugl hook status             # show whether the hook is installed
frugl hook uninstall          # remove it
```

The hook runs the same local anonymizer as a manual upload. It needs a token
available headlessly — `frugl setup` first.

## Organizations

Every Frugl account belongs to an org today — the team whose AI retros you
share (multi-org support is coming). `frugl setup` handles this for you; a
brand-new account is prompted to
**create** an org (you become the owner) or **join** an existing one with an
invite code. Until you belong to an org, `frugl upload` is blocked.

```bash
frugl org                              # show your active org, role, and member count
frugl org create --name "Acme Corp"    # non-interactive create (slug auto-derived)
frugl org join pop_inv_…               # redeem an invite code from a teammate
frugl org use <slug>                   # (not implemented) one org per account today; confirms current org only
frugl org invites                      # how to get an invite code
```

Invite codes come from a teammate — org owners and admins generate them on the
dashboard.

## Snapshots

`frugl snapshot` captures two timestamped, locally-anonymized snapshots and
uploads them in one run:

- **`frugl snapshot context`** — the configured AI tool's context-window
  breakdown (today Claude Code's `/context`). It spawns `claude -p "/context"`
  and uploads only what that command prints to stdout: category token counts
  plus config identifiers (skill / MCP server / agent names and memory-file
  paths). It never reads or uploads the **contents** of any file the breakdown
  references.
- **`frugl snapshot mcp`** — your declared MCP servers from `claude mcp list`
  (name, transport, target, health). Each server **target** (a URL or launch
  command that can embed a key) is scrubbed of secrets locally before upload.

Bare `frugl snapshot` runs both; each runs independently, so a failure in one
never blocks the other. Embedded secrets and third-party emails are redacted,
and your home-directory prefix is normalized, by the same local anonymizer the
upload path uses (fail-closed).

```bash
frugl snapshot                 # capture, anonymize, upload context + mcp
frugl snapshot context         # just the context-window snapshot
frugl snapshot mcp             # just the MCP-server snapshot
frugl snapshot --format json   # machine-readable result (capturedAt, manifestId, …)
```

**Cadence (v1).** There is no built-in scheduler. To accumulate snapshots over
time — which is what makes them useful for spotting context-window drift — run
`frugl snapshot` on a recurring schedule from an external cron/CI job, roughly
daily:

```cron
0 9 * * * frugl snapshot >> ~/.frugl/snapshot.log 2>&1
```

Each run produces a **distinct** snapshot (fresh id + fresh timestamp) — there
is no overwrite or dedupe. A failed run (tool missing, no output, network blip)
exits non-zero, uploads nothing, and **never blocks the next run**.

## Why open source?

The CLI sees raw session content before redaction. You should be able to
read its source — especially the anonymizer — before trusting it with that
data. The full redaction policy lives under `src/anonymize/` with vitest tests
asserting that planted secrets across every category are removed (SC-001).
Redaction is **fail-closed**: if the anonymizer can't finish, the upload aborts
rather than risk sending unredacted bytes.

For the full contributor and verifier walk-through — including how to run the
CLI against the sibling local Docker stack and verify the trust gate yourself
with planted secrets — see
[`specs/001-cli-ingest-client/quickstart.md`](./specs/001-cli-ingest-client/quickstart.md).

## Contributing

Building, testing, releasing, and project governance live in
[`DEVELOPMENT.md`](./DEVELOPMENT.md).

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
for retrospective waste analysis. You get a dashboard and ranked, cost-saving
recommendations — "you reload the same 40k-token file every session," "this agent
loops on a failing test" — so your team spends fewer tokens getting the same work done.

The catch every team worries about: _your raw prompts and code never leave your
machine._ The anonymizer runs **locally, before any byte is transmitted**, and it
[**fails closed**](#why-open-source) — if redaction can't complete, nothing uploads.
That's also why this CLI is open source: you can read exactly what it does to your
data before you trust it with any.

## Quick start

```bash
npm install -g frugl                 # or run ad-hoc with: npx frugl <command>

frugl setup                          # sign in + create/join an org in one step
frugl upload                         # discover, anonymize, and upload your sessions
frugl recommendations                # see ranked, cost-saving fixes
```

That's the whole loop: **setup → upload → act on recommendations.** Everything
below is the detail.

## Commands

| Command                 | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `frugl setup`           | Authenticate **and** create/join an org in one idempotent step. Safe to re-run. |
| `frugl login`           | Sign in with an emailed one-time code; token stored in the OS keychain.         |
| `frugl logout`          | Revoke this device's session and forget the local token.                        |
| `frugl whoami`          | Show the signed-in identity, active org, and role.                              |
| `frugl upload`          | Discover, anonymize, and upload local AI-coding sessions.                       |
| `frugl recommendations` | List and rank cost-saving recommendations; print a fix prompt.                  |
| `frugl context`         | Capture + upload a timestamped context-window snapshot.                         |
| `frugl org`             | Manage your org (`create`, `join`, `use`, `invites`, `ls`).                     |
| `frugl hook install`    | Auto-upload from a Claude Code hook when a session ends.                        |

Every command supports `--json` for machine-readable output and `--help` for
the full flag list.

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

```bash
frugl upload --dry-run                     # discover + anonymize; transmit zero bytes
frugl upload --dry-run --inspect ./out     # also write the redacted output to ./out
frugl upload --confirm                     # upload without prompting
```

Non-interactive runs (`--yes`/`--confirm`, `--json`, or no TTY such as CI)
skip the prompts and select every detected supported provider and all of its
projects automatically.

After a successful upload, the printed dashboard link carries a **single-use,
~60-second sign-in code** (`?handoff=…`) so opening it lands you on your
dashboard already signed in — no second login. The code is **not** your CLI
token, dies on first use or expiry, and is **off by default in non-interactive
runs** (CI, pipes, `--json`); pass `--handoff` to opt in there, or `--no-handoff`
to keep it out of any printed output (shared or recorded terminals). If the link
has expired, the web login returns you to the same dashboard page afterwards.

## Recommendations

Once you've uploaded a few sessions, Frugl ranks where your team is burning
tokens and hands you a ready-to-paste prompt to fix each one:

```bash
frugl recommendations                  # list, ranked by estimated savings
frugl recommendations --fix <id>       # print the fix prompt for one recommendation
frugl recommendations --apply <id>     # mark it applied
frugl recommendations --dismiss <id>   # snooze it for 30 days
```

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

Every Frugl account belongs to exactly one org — the team whose AI retros you
share. `frugl setup` handles this for you; a brand-new account is prompted to
**create** an org (you become the owner) or **join** an existing one with an
invite code. Until you belong to an org, `frugl upload` is blocked.

```bash
frugl org                              # show your active org, role, and member count
frugl org create --name "Acme Corp"    # non-interactive create (slug auto-derived)
frugl org join pop_inv_…               # redeem an invite code from a teammate
frugl org use <slug>                   # switch the active org for uploads
frugl org invites                      # how to get an invite code
```

Invite codes come from a teammate — org owners and admins generate them on the
dashboard.

## Context snapshots

`frugl context` captures the configured AI tool's context-window breakdown —
today Claude Code's `/context` — anonymizes it locally, and uploads a single
**timestamped** snapshot. It launches the tool by spawning `claude -p "/context"`
and uploads only what that command prints to stdout: category token counts plus
config identifiers (skill / MCP server / agent names and memory-file paths). It
never reads or uploads the **contents** of any file the breakdown references.
Embedded secrets and third-party emails are redacted, and your home-directory
prefix is normalized, by the same local anonymizer the upload path uses
(fail-closed).

```bash
frugl context                 # capture, anonymize, upload one snapshot
frugl context --json          # machine-readable result (capturedAt, manifestId, …)
```

**Cadence (v1).** There is no built-in scheduler. To accumulate snapshots over
time — which is what makes them useful for spotting context-window drift — run
`frugl context` on a recurring schedule from an external cron/CI job, roughly
daily:

```cron
0 9 * * * frugl context >> ~/.frugl/context.log 2>&1
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

## Sibling repos

This is one of three repos that make up the cloud product
(`~/Documents/frugl/` on the maintainer's machine):

- `frugl/` (private) — fullstack web app + processing pipelines.
- `frugl-cli/` (this repo, public) — the CLI.
- `frugl-site/` (public) — the marketing site.

## Stack

TypeScript · Node ≥ 20 · `@oclif/core` for the command framework ·
`@inquirer/prompts` for interactive input · OS keychain via `@napi-rs/keyring`
for token storage · `zod` for cloud-contract validation · `p-retry` + `p-limit`
for bounded retry and concurrency · `conf` for cross-platform state
persistence · vitest · oxlint · oxfmt · pnpm.

## Development

```bash
pnpm install
pnpm test               # vitest (anonymization fixtures are first-class)
pnpm typecheck
pnpm lint
pnpm format:check
pnpm dev <command>      # tsx-driven oclif dev entrypoint
```

Point the CLI at a local dev stack:

```bash
FRUGL_ENDPOINT=http://localhost:54321 pnpm dev login
```

The local stack itself (Supabase + MinIO) is brought up from the
`frugl/` repo via `pnpm stack:up`.

## Releasing

`frugl` ships to npm as a compiled oclif CLI. `pnpm build` compiles `src/` to
`dist/` (preserving the per-command file layout oclif discovers at runtime) and
generates `oclif.manifest.json`. The published tarball contains only
`bin/run.js`, `dist/`, the manifest, `brand/`, `README.md`, and `LICENSE` (see
the `files` field) — never `src/`, tests, or `bin/dev.js`.

Inspect exactly what would be published without uploading anything:

```bash
npm pack --dry-run      # runs prepack (build + manifest), lists tarball contents
```

Publishing is automated by [`.github/workflows/release.yml`](./.github/workflows/release.yml):

1. Bump `version` in `package.json` and commit on `main`.
2. Create a GitHub Release whose tag matches the version (e.g. `v0.1.0`).
3. The workflow runs the full verify suite, then `npm publish --provenance --access public`.

One-time setup: add an automation **`NPM_TOKEN`** secret to the repo
(npmjs.com → Access Tokens → Granular/Automation token with publish rights for
`frugl`). The workflow requests `id-token: write` so npm attaches a signed
provenance attestation to the release.

To publish manually instead (requires `npm login` locally):

```bash
npm publish --access public
```

## Governance

This repo inherits the constitution at
`../frugl/.specify/memory/constitution.md`. Anonymization specifically is
governed by Principle VI ("Fail-Closed Anonymization, IaC Source-of-Truth,
Honest Failures").

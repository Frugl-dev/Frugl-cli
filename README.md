# `frugl` — the Frugl CLI

Public, open-source command-line tool that uploads anonymized AI-coding
session logs from your machine to **hosted Frugl** for retrospective waste
analysis. The anonymizer runs **locally**, before any byte leaves your
machine.

```bash
npm install -g frugl          # or: npx frugl <command>
frugl login                   # email one-time code; token stored in OS keychain
                              #   first-time accounts are prompted to create or join an org
frugl whoami                  # show signed-in identity + active org and role
frugl org                     # show your active org (alias: frugl org ls)
frugl org create              # start a new org (you become the owner)
frugl org join <code>         # accept an invite code from a teammate
frugl upload --dry-run        # discover + anonymize; transmit zero bytes
frugl upload --dry-run --inspect ./out   # also write redacted output to ./out
frugl upload --confirm        # upload anonymized sessions to the cloud
frugl context                 # capture + upload a timestamped context snapshot
frugl logout                  # invalidate session, forget token
```

For the full contributor and verifier walk-through (including how to run the
CLI against the sibling local Docker stack and how to verify the trust gate
yourself with planted secrets), see
[`specs/001-cli-ingest-client/quickstart.md`](./specs/001-cli-ingest-client/quickstart.md).

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

Non-interactive runs (`--yes`/`--confirm`, `--json`, or no TTY such as CI)
skip the prompts and select every detected supported provider and all of its
projects automatically.

After a successful upload, the printed dashboard link carries a **single-use,
~60-second sign-in code** (`?handoff=…`) so opening it lands you on your
dashboard already signed in — no second login. Privacy notes: the code is not
your CLI token, dies on first use or expiry, and is **off by default in
non-interactive runs** (CI, pipes, `--json`); pass `--handoff` to opt in there,
or `--no-handoff` to keep it out of any printed output (shared or recorded
terminals). If the link has expired, the web login returns you to the same
dashboard page afterwards.

## Organizations

Every Frugl account belongs to exactly one org — the team whose AI retros you
share. A brand-new account is prompted right after `frugl login` to **create**
an org (you become the owner) or **join** an existing one with an invite code.
Until you do, `frugl upload` is blocked.

```bash
frugl org                     # show your active org, role, and member count
frugl org create --name "Acme Corp"   # non-interactive create (slug auto-derived)
frugl org join pop_inv_…      # redeem an invite code from a teammate
```

Invite codes come from a teammate (org owners/admins generate them on the
dashboard); accept one with `frugl org join <code>`.

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
read its source — especially the anonymizer — before trusting it with
that data. The full redaction policy lives under `src/anonymize/` with
vitest tests asserting that planted secrets across every category are
removed (SC-001).

## Sibling repos

This is one of three repos that make up the cloud product
(`~/Documents/frugl/` on the maintainer's machine):

- `frugl/` (private) — fullstack web app + processing pipelines.
- `frugl-cli/` (this repo, public) — the CLI.
- `frugl-site/` (public) — the marketing site.

## Stack

TypeScript · Node ≥ 20 · `@oclif/core` for command framework · `@inquirer/prompts`
for interactive input · OS keychain via `@napi-rs/keyring` for token
storage · `zod` for cloud-contract validation · `p-retry` + `p-limit`
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
`bin/run.js`, `dist/`, the manifest, `README.md`, and `LICENSE` (see the `files`
field) — never `src/`, tests, or `bin/dev.js`.

Inspect exactly what would be published without uploading anything:

```bash
npm pack --dry-run      # runs prepack (build + manifest), lists tarball contents
```

Publishing is automated by [`.github/workflows/release.yml`](./.github/workflows/release.yml):

1. Bump `version` in `package.json` and commit on `main`.
2. Create a GitHub Release whose tag matches the version (e.g. `v0.1.0`).
3. The workflow runs the full verify suite, then `npm publish --provenance
--access public`.

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

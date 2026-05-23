# `poppi` — the Poppi CLI

Public, open-source command-line tool that uploads anonymized AI-coding
session logs from your machine to **hosted Poppi** for retrospective waste
analysis. The anonymizer runs **locally**, before any byte leaves your
machine.

```bash
npm install -g poppi          # or: npx poppi <command>
poppi login                   # email one-time code; token stored in OS keychain
poppi whoami                  # show signed-in identity
poppi upload --dry-run        # discover + anonymize; transmit zero bytes
poppi upload --dry-run --inspect ./out   # also write redacted output to ./out
poppi upload --confirm        # upload anonymized sessions to the cloud
poppi logout                  # invalidate session, forget token
```

For the full contributor and verifier walk-through (including how to run the
CLI against the sibling local Docker stack and how to verify the trust gate
yourself with planted secrets), see
[`specs/001-cli-ingest-client/quickstart.md`](./specs/001-cli-ingest-client/quickstart.md).

## Why open source?

The CLI sees raw session content before redaction. You should be able to
read its source — especially the anonymizer — before trusting it with
that data. The full redaction policy lives under `src/anonymize/` with
vitest tests asserting that planted secrets across every category are
removed (SC-001).

## Sibling repos

This is one of three repos that make up the cloud product
(`~/Documents/poppi/` on the maintainer's machine):

- `poppi/` (private) — fullstack web app + processing pipelines.
- `poppi-cli/` (this repo, public) — the CLI.
- `poppi-site/` (public) — the marketing site.

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
POPPI_ENDPOINT=http://localhost:54321 pnpm dev login
```

The local stack itself (Supabase + MinIO) is brought up from the
`poppi/` repo via `pnpm stack:up`.

## Governance

This repo inherits the constitution at
`../poppi/.specify/memory/constitution.md`. Anonymization specifically is
governed by Principle VI ("Fail-Closed Anonymization, IaC Source-of-Truth,
Honest Failures").

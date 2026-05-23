# `poppi` — the Poppi CLI

Public, open-source command-line tool that uploads anonymized AI-coding
session logs from your machine to **hosted Poppi** for retrospective waste
analysis. The anonymizer runs **locally**, before any byte leaves your
machine.

```bash
npx poppi login          # email one-time code; token stored in OS keychain
npx poppi upload         # discover sources, anonymize, batch-upload
npx poppi upload --dry-run --inspect   # write redacted output locally, no network
npx poppi delete --upload <id>         # remove an upload (S3 + Postgres)
npx poppi delete --account             # purge everything
```

## Why open source?

The CLI sees raw session content before redaction. You should be able to
read its source — especially the anonymizer — before trusting it with
that data. The full redaction policy lives under `src/anonymize/` with
vitest tests asserting that planted secrets across every category are
removed.

## Sibling repos

This is one of three repos that make up the cloud product
(`~/Documents/poppi/` on the maintainer's machine):

- `poppi/` (private) — fullstack web app + processing pipelines.
- `poppi-cli/` (this repo, public) — the CLI.
- `poppi-site/` (public) — the marketing site.

The historical local-only DuckDB Poppi lives separately at
`~/Documents/Poppi-local/`.

## Stack

TypeScript · Node ≥ 20 · `commander` for arg parsing · `@supabase/supabase-js`
for auth · OS keychain via `keytar` (or platform-native fallback) for token
storage · vitest · oxlint · oxfmt · pnpm.

## Development

```bash
pnpm install
pnpm test               # vitest (anonymization fixtures are first-class)
pnpm typecheck
pnpm lint
pnpm format:check
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

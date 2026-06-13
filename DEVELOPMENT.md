# Developing `frugl`

Contributor and maintainer docs for the Frugl CLI. For what the CLI does and
how to use it, see [`README.md`](./README.md).

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
</content>

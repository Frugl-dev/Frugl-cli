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

### Pointing the CLI at a local dev stack

The CLI talks to the **Astro app** (default `http://localhost:4321`), not
Supabase's port. There are three ways to target it, in precedence order:

```bash
# 1. Per-command flag (highest precedence)
pnpm dev login --endpoint http://localhost:4321

# 2. Environment variable — bin/dev.js auto-loads .env (FRUGL_ENDPOINT=...),
#    so plain `pnpm dev <cmd>` already targets local inside this repo.
FRUGL_ENDPOINT=http://localhost:4321 pnpm dev login

# 3. Persisted at login — a successful `login` REMEMBERS its endpoint, so
#    every later command (including the globally-installed `frugl`) keeps
#    targeting it with no flag/env. `frugl logout` clears it back to prod.
frugl login --endpoint http://localhost:4321
frugl snapshot context        # now goes to local, not app.frugl.dev
```

> **Heads-up:** the installed global `frugl` does **not** read this repo's
> `.env` (only `pnpm dev` does), and it defaults to **production**
> (`https://app.frugl.dev`). Sign in once with an explicit
> `--endpoint http://localhost:4321` and the saved endpoint sticks — otherwise
> an unprefixed `frugl <cmd>` uploads to prod. A one-off `--endpoint` /
> `FRUGL_ENDPOINT` always overrides the saved value.

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

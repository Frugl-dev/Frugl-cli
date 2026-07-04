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

# 3. Project pin — a `.frugl.json` at the repo root (written by `frugl init`,
#    or by hand: {"endpoint": "http://localhost:4321"}) is the project's
#    source of truth. Every command run inside that repo targets the pinned
#    endpoint with no flag/env — including the globally-installed `frugl`.
frugl init --endpoint http://localhost:4321
frugl snapshot context        # now goes to local, not app.frugl.dev
```

> **Heads-up:** the installed global `frugl` does **not** read this repo's
> `.env` (only `pnpm dev` does), and it defaults to **production**
> (`https://app.frugl.dev`). There is deliberately no machine-global
> "remembered endpoint" — login does NOT persist where you signed in. Pin the
> endpoint in the project's `.frugl.json` (via `frugl init`) or pass
> `--endpoint` / `FRUGL_ENDPOINT` explicitly, otherwise an unprefixed
> `frugl <cmd>` talks to prod.

The local stack itself (Supabase + MinIO) is brought up from the
`frugl/` repo via `pnpm stack:up`.

## Releasing

`frugl` ships to npm as a compiled oclif CLI. `pnpm build` compiles `src/` to
`dist/` (preserving the per-command file layout oclif discovers at runtime),
generates `oclif.manifest.json`, and renders the man page to `man/frugl.1`. The
published tarball contains only `bin/run.js`, `dist/`, the manifest, `man/frugl.1`,
`scripts/postinstall-man.mjs`, `brand/`, `README.md`, and `LICENSE` (see the
`files` field) — never `src/`, tests, or `bin/dev.js`.

### Man page

`man frugl` is generated, never hand-written — `scripts/build-manpage.mjs` reads
`oclif.manifest.json` (the same metadata behind `frugl --help`) and emits roff to
`man/frugl.1`, so the page can't drift from the real command surface. It runs as
the last step of `pnpm build`; the output is gitignored and regenerated each build.

npm stopped linking `package.json` `man` entries in v9, so a `postinstall`
(`scripts/postinstall-man.mjs`) links the shipped page into `<prefix>/share/man/man1/`
on a **global** install — `man` finds it there because `<prefix>/bin` is already on
`$PATH`. It is best-effort and a strict no-op on local installs, so it never
blocks `npm install`. Preview locally without installing: `man ./man/frugl.1`.

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

## Standalone binaries (no Node required)

Alongside the npm publish, [`.github/workflows/pack.yml`](./.github/workflows/pack.yml)
builds **self-contained tarballs** on the same `release: published` event and
attaches them to the GitHub Release. Each tarball bundles Node
(`oclif.update.node.version` in `package.json`, currently 26.4.0) plus the
production-only `node_modules`, so a user can download, extract, and run
`frugl/bin/frugl` without Node installed. These artifacts are what a Homebrew
formula (or any direct-download install) consumes.

Build one locally for your own platform:

```bash
pnpm pack:tarballs                 # -> dist/frugl-v<version>-<sha>-<target>.tar.gz
```

### Two non-obvious gotchas (already handled in CI)

1. **pnpm's ancestor-root detection breaks the bundled `node_modules`.** oclif
   stages its build workspace at `./tmp/frugl` _inside_ this repo, then runs
   `pnpm install --production` there. With no `pnpm-workspace.yaml` of its own,
   `tmp/frugl` isn't a self-contained project as far as pnpm is concerned:
   pnpm walks up to the nearest ancestor `.git` (this repo's root) and installs
   **there** instead — reporting "Already up to date" against the repo's own
   already-installed `node_modules` — while `tmp/frugl` itself ends up with
   **no `node_modules` at all**. The packed tarball then ships totally broken
   (`Cannot find package '@oclif/core'` at startup). Worse, that misdirected
   install can _prune your own repo's `node_modules` to production_.
   `pnpm-workspace.yaml` is in `package.json`'s `files` list, and the pack
   workflow blanks it to `packages: []` before packing — `npm pack` bundles
   that empty marker into the CLI tarball oclif extracts into `tmp/frugl`,
   so `tmp/frugl` is its own workspace root before the nested install ever
   runs, and pnpm never walks past it. To pack locally, do the same and
   restore it after:

   ```bash
   mv pnpm-workspace.yaml pnpm-workspace.yaml.bak
   echo 'packages: []' > pnpm-workspace.yaml
   pnpm pack:tarballs
   mv pnpm-workspace.yaml.bak pnpm-workspace.yaml
   pnpm install --frozen-lockfile   # restore dev deps if the nested install pruned them
   ```

2. **Native keyring is per-platform, so each target packs on its own runner.**
   `@napi-rs/keyring` ships a prebuilt `.node` per platform/arch as an optional
   dependency; only the host's variant installs. The matrix therefore packs
   `darwin-arm64` on macOS arm, `darwin-x64` on macOS intel, and the two Linux
   arches on native Linux runners — cross-packing would ship a keyring binary
   that can't load.

### Size

A bundled tarball is ~45 MB (`.tar.gz`) / ~29 MB (`.tar.xz` — the workflow emits
both via `--xz`). The compressed Node runtime is essentially all of it (the
binary is ~138 MB uncompressed); the app is <1 MB and prod deps ~21 MB. That
floor is inherent to shipping a runtime — comparable single-file tools
(bun/deno/pkg) land in the same 40–100 MB range. The only way materially smaller
is a **system-node** tarball (a few MB) that requires Node on the machine, which
defeats the purpose. `devDependencies` are already excluded by
`--production`, so no test/lint tooling is bundled.

### Homebrew (next step)

The Release assets are ready to back a tap. A minimal formula pins the two macOS
tarballs by SHA-256 and symlinks the launcher — sketch:

```ruby
class Frugl < Formula
  desc "Upload anonymized AI-coding session logs to hosted Frugl"
  homepage "https://github.com/Frugl-dev/Frugl-cli"
  version "0.1.6"
  on_macos do
    on_arm do
      url "https://github.com/Frugl-dev/Frugl-cli/releases/download/v0.1.6/frugl-v0.1.6-<sha>-darwin-arm64.tar.gz"
      sha256 "..."
    end
    on_intel do
      url "https://github.com/Frugl-dev/Frugl-cli/releases/download/v0.1.6/frugl-v0.1.6-<sha>-darwin-x64.tar.gz"
      sha256 "..."
    end
  end
  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/frugl"
  end
  test do
    assert_match "frugl/#{version}", shell_output("#{bin}/frugl --version")
  end
end
```

Publish it in a `Frugl-dev/homebrew-frugl` tap so users get
`brew install frugl-dev/frugl/frugl`. Automating the tap bump (URL + `sha256`)
from the release is a small follow-up.

## Governance

This repo inherits the constitution at
`../frugl/.specify/memory/constitution.md`. Anonymization specifically is
governed by Principle VI ("Fail-Closed Anonymization, IaC Source-of-Truth,
Honest Failures").
</content>

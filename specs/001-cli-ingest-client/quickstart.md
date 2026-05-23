# Quickstart: poppi-cli v1

**Feature**: 001-cli-ingest-client | **Date**: 2026-05-23

Two audiences:

1. **Contributors** — getting the CLI running locally against the sibling `poppi/` Docker stack, running the test suite, and iterating on the anonymizer.
2. **Trust-gate verifiers** — running the planted-secrets fixture and the `--dry-run --inspect` flow against your own sessions before ever uploading for real.

---

## 1. Prerequisites

- Node.js **≥ 20** (the runtime floor; spec.md Dependencies → Framework & runtime constraints).
- pnpm (`corepack enable && corepack prepare pnpm@latest --activate`).
- Docker (for the local cloud stack — see step 4).
- A working OS credential store: macOS Keychain, Windows Credential Manager, or a running secret-service on Linux (`libsecret` + a session keyring). On headless Linux without those, the CLI exits cleanly with `KEYCHAIN_UNAVAILABLE` (11) per FR-005 — install one before running `poppi login`.

---

## 2. Clone and install

```bash
git clone https://github.com/<you>/poppi.git ~/Documents/poppi
cd ~/Documents/poppi/poppi-cli
pnpm install
```

The `poppi-cli` directory is a sibling of `poppi/` (the cloud + Docker stack) and `poppi-site/` (the marketing site). The constitution at `../poppi/.specify/memory/constitution.md` is the authoritative governance document for this repo.

---

## 3. Verify the toolchain

```bash
pnpm typecheck     # tsc --noEmit; strict mode, exact-optional-property-types
pnpm lint          # oxlint
pnpm format:check  # oxfmt --check
pnpm test          # vitest run; includes the planted-secrets fixture (SC-001)
```

All four are wired into the `pre-commit` hook in `package.json`. The constitution forbids `git commit --no-verify` — that pre-commit gate is non-negotiable (Principle V).

---

## 4. Bring up the local cloud stack

In a separate terminal, in the sibling `poppi/` repo:

```bash
cd ~/Documents/poppi/poppi
pnpm stack:up      # Supabase + S3-compatible object store (MinIO) + the web app
```

The stack listens on `http://localhost:54321` (Supabase) plus the cloud's own Astro endpoints. This URL is the canonical CI target (SC-004) and the recommended local-development endpoint.

---

## 5. Run the CLI in dev mode against the local stack

```bash
export POPPI_ENDPOINT=http://localhost:54321

pnpm dev login
# Email prompt → check the local stack's mailcatcher for the 6-digit code
# Token persists in OS keychain under service `poppi`, account `<endpoint>`

pnpm dev whoami    # confirms you're signed in, prints {email, userId, endpoint}

pnpm dev upload --dry-run --inspect ./poppi-inspect
# Discovers sessions under ~/.claude/projects/**/*.jsonl
# Anonymizes them in memory
# Writes redacted payload + per-session redaction summary to ./poppi-inspect/
# Transmits ZERO bytes. Confirm with a packet sniffer if you don't trust the docs.

pnpm dev upload --confirm
# Same pipeline, but actually uploads.
# Prints manifest ID and dashboard URL on success.
```

`pnpm dev` shells out to `tsx src/cli.ts` (during the Phase-2 migration this becomes `bin/dev.js`); both invoke the same oclif runtime.

---

## 6. Verify the trust gate yourself (the FR-019 / SC-002 loop)

The point of open-sourcing the CLI is that you don't have to take our word for it. The redaction policy is in `src/anonymize/`; the planted-secrets fixture is in `src/anonymize/anonymize.test.ts`.

```bash
# Run the planted-secrets suite — SC-001 says 100% of planted values are absent.
pnpm test src/anonymize/

# Or run the dry-run inspection against your own logs and grep the output for
# anything you don't want to leave your machine:
pnpm dev upload --dry-run --inspect ./poppi-inspect
rg --hidden 'sk-ant-' ./poppi-inspect/         # any Anthropic key still in cleartext?
rg --hidden "$HOME" ./poppi-inspect/           # any home-dir path still in cleartext?
rg --hidden '@gmail|@yahoo|@hotmail' ./poppi-inspect/    # any third-party email?
```

If you find a value that should have been redacted but wasn't, that's an SC-001-blocking regression — please file an issue with the offending fixture (sanitized).

---

## 7. Iterate on the anonymizer

The anonymizer's rule modules live under `src/anonymize/rules/`. Each rule:

- exports a `pure-function` shape `(input: string, ctx: AnonContext) => RedactionApplication[]`,
- has co-located tests under `*.test.ts`,
- contributes to the `RedactionCategory` enum in `src/anonymize/index.ts`.

Adding a new rule:

1. Add a fixture line to `src/anonymize/anonymize.test.ts`'s `PLANTED` table.
2. Write the rule module + tests under `src/anonymize/rules/`.
3. Wire it into `src/anonymize/index.ts`.
4. Bump `POLICY_VERSION` in `src/anonymize/policy.ts` per the rule in research.md R-12 (MINOR for added rule, MAJOR for any rule weakening).

The pre-commit gate (`format`, `lint`, `typecheck`, `test`) MUST pass before commit.

---

## 8. Run the four-command happy path end-to-end (the SC-004 loop)

The CI workflow exercises this; you can do the same locally. With the local stack up:

```bash
export POPPI_ENDPOINT=http://localhost:54321

pnpm dev login                                   # → OK, FR-001
pnpm dev whoami                                  # → prints identity, FR-003
pnpm dev upload --dry-run --inspect ./out-dry    # → writes inspection dir, FR-019, no network
pnpm dev upload --confirm                        # → uploads, FR-024/025
pnpm dev upload --confirm                        # → "No new or updated sessions", FR-029
pnpm dev upload --limit 1 --confirm              # → uploads at most 1 (new ∪ updated), FR-006a
pnpm dev logout                                  # → invalidates session, FR-002
pnpm dev whoami                                  # → not logged in, exit code 10 (AUTH_FAILURE)
```

All exit codes are documented in `contracts/exit-codes.md` and pinned in `src/lib/exit-codes.ts`. Branch on the code, not the prose.

---

## 9. Useful flag combinations

| Goal                                         | Command                                                    |
| -------------------------------------------- | ---------------------------------------------------------- | ------ |
| See what would upload, write nothing to disk | `poppi upload --dry-run`                                   |
| See what would upload, write inspection dir  | `poppi upload --dry-run --inspect ./out`                   |
| Force overwrite an existing inspection dir   | `poppi upload --dry-run --inspect ./out --force`           |
| Non-interactive upload (CI / scripts)        | `poppi upload --confirm` (or `--yes`)                      |
| Cap the batch at 1 session for testing       | `poppi upload --limit 1 --confirm`                         |
| Tune concurrency                             | `poppi upload --concurrency 2 --confirm` (default 4)       |
| Machine-readable progress for piping         | `poppi upload --json --confirm                             | jq -c` |
| Point at a non-default endpoint              | `poppi upload --endpoint http://localhost:54321 --confirm` |

---

## 10. Where things live

| Concern                                         | Path                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Anonymizer (the trust gate)                     | `src/anonymize/`                                                  |
| Source adapters (FR-007 extension point)        | `src/sources/`                                                    |
| Local upload ledger (FR-006c)                   | `src/ledger/`                                                     |
| Upload pipeline + resume                        | `src/upload/`                                                     |
| Cloud HTTP boundary + zod schemas               | `src/cloud/`                                                      |
| Exit-code table                                 | `src/lib/exit-codes.ts`                                           |
| Keychain wrapper                                | `src/auth/keychain.ts`                                            |
| Persisted state (resume + ledger)               | `conf`-managed under env-paths state dir (see `src/lib/paths.ts`) |
| Public contracts (manifest, NDJSON, exit codes) | `specs/001-cli-ingest-client/contracts/`                          |

For more on any of these, the spec is `specs/001-cli-ingest-client/spec.md` and the plan is `specs/001-cli-ingest-client/plan.md`.

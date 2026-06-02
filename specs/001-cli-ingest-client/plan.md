# Implementation Plan: frugl-cli v1 — Public OSS Ingest Client

**Branch**: `001-cli-ingest-client` | **Date**: 2026-05-23 | **Spec**: [./spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-cli-ingest-client/spec.md`

## Summary

`frugl-cli` is the only ingest path into the hosted Frugl cloud and the public trust gate of the product: it discovers AI-coding session logs on the user's machine, anonymizes every byte client-side with a fail-closed policy, and uploads to that user's isolated cloud prefix.

The technical approach is a single TypeScript Node ≥ 20 CLI distributed via `npm i -g frugl` / `npx frugl`, structured around oclif's command-class + plugin architecture (locked at spec level to keep FR-007's open extension point for future source adapters viable). The six load-bearing dependencies named in the spec (`zod`, `semver`, `p-retry`, `p-limit`, `@inquirer/prompts`, `conf`) are joined by Node-built-in choices for everything else (native `fetch`, `crypto`, `zlib`) and a small set of well-trodden helpers (`tinyglobby`, `picocolors`, `@napi-rs/keyring`).

The pipeline is: **discover → derive stable identity → classify against local ledger → apply `--limit` → anonymize → confirm → bounded-concurrency PUT to presigned URLs → resumable manifest finalize**. Anonymization runs before any network bytes, retries are bounded and excluded for auth/version-gate failures, output emits stable NDJSON under `--json` (FR-036/039 contract surface) and human progress on stderr by default.

Note: the existing `src/` scaffold uses `commander`, `prompts`, `keytar`, and `@supabase/supabase-js`. Phase 2 will migrate it to oclif + `@inquirer/prompts` + `@napi-rs/keyring` + native `fetch`, and remove the `delete` command (deferred to spec `002-delete`).

## Technical Context

**Language/Version**: TypeScript 6.x, Node.js ≥ 20.

**Primary Dependencies (locked at spec level — see spec.md Dependencies)**:

- CLI framework: **oclif** (`@oclif/core`)
- Cloud-contract validation: **`zod`**
- Version-gate parsing: **`semver`**
- Bounded retry: **`p-retry`**
- Bounded concurrency: **`p-limit`**
- Interactive prompts: **`@inquirer/prompts`**
- Cross-platform state-dir persistence: **`conf`**

**Primary Dependencies (decided in this plan — see research.md)**:

- HTTP client: Node 20 native `fetch` (undici-backed) with `AbortController`
- Glob walker: **`tinyglobby`**
- Hashing / UUID / gzip: Node built-ins (`crypto.createHash('sha256')`, `crypto.randomUUID()`, `zlib`)
- OS credential store: **`@napi-rs/keyring`** (replaces `keytar` from current scaffold; prebuilt N-API binaries, no node-gyp)
- Color / progress: **`picocolors`** (tiny, zero-dep)
- Build: **`tsup`** (already in repo)
- Test: **`vitest`** (already in repo, mandated by constitution Principle V)

**Storage**:

- **OS keychain** (`@napi-rs/keyring`) — auth tokens only. Never plaintext on disk (FR-004).
- **State directory** (`conf`, env-paths conventions) — two `conf` namespaces under the OS-appropriate state dir:
  - `frugl-resume-state` — in-flight upload identifier + per-session ack status (FR-026)
  - `frugl-ledger` — per-`(endpoint, user)` map of `sessionId → {contentHash, lastUploadedAt, manifestId}` (FR-006c)
- **No application database.** The cloud is the system of record for uploaded sessions; the CLI persists only the two `conf` namespaces above.

**Testing**: vitest, co-located `*.test.ts` next to source (matches existing convention in `src/anonymize/anonymize.test.ts`). Three test tiers:

- **Unit** — anonymizer rules + planted-secrets fixture (SC-001), classifier (FR-006d), retry predicate (FR-029a/b), pseudonym stability (FR-016).
- **Contract** — `zod` round-trip every cloud response against the recorded schemas in `contracts/`. Drift = test failure.
- **Integration** — full `login → discover → anonymize → upload → dashboard-visible` loop against the local Docker stack brought up from the sibling `frugl/` repo (`pnpm stack:up`). Per SC-004, this loop must complete with zero external credentials and zero internet access; the same loop runs in CI.

**Target Platform**: Cross-platform — macOS, Windows, Linux. All on Node ≥ 20. Headless Linux without a system secret service is explicitly out of scope (FR-005: surface clear error, refuse to start, exit cleanly).

**Project Type**: Single-package CLI (not a workspace; `pnpm-workspace.yaml` exists for the trust-gate-friendly convention of pinning `allowBuilds` per native dep, not for splitting code).

**Performance Goals**:

- **SC-003**: First upload ≤ 200 sessions / ≤ 200 MB compressed completes in ≤ 60 s on broadband.
- **SC-003a**: Incremental classification of M = 1000 sessions on disk completes in ≤ 5 s on a typical developer laptop; subsequent transmission time scales with the (new ∪ updated) subset only.
- **SC-007**: Zero network traffic in any 24-hour window in which the user does not invoke a frugl command.

**Constraints**:

- **Privacy posture (FR-034/035 + Principle VI)**: no telemetry, no auto-update, no background activity. Every network request is a direct, traceable consequence of a user-invoked command.
- **Output contract surface (FR-036)**: manifest JSON, redaction-summary JSON, NDJSON event shape, final-summary JSON, and exit codes are all public contracts; non-additive changes require a coordinated cross-repo bump with `frugl/001-cloud-ingest-platform`.
- **Trust gate (FR-009/014)**: anonymization MUST run on every byte before any network transmission, fail-closed on uncertainty. `--dry-run` MUST transmit nothing.
- **Concurrency (FR-025a)**: fixed default 4, overridable via `--concurrency N`. No adaptive scheme in v1.
- **Retry (FR-029a/b)**: 3 attempts total, transient errors only (network reset, request timeout, HTTP 5xx, HTTP 429). Auth/version-gate/other 4xx never retried.

**Scale/Scope**:

- v1 CLI surface = 4 user-facing commands (`login`, `logout`, `whoami`, `upload`) + `--version` + `--help`.
- v1 supports 1 source kind (Claude Code JSONL at `~/.claude/projects/`). Source registry is the FR-007 extension seam for future spec `004-sources`.
- Per-batch session count: realistic upper bound ~10⁴ sessions on disk; classification must scale linearly with disk count, transmission scales with the (new ∪ updated) subset.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

The applicable constitution is **Frugl Cloud Constitution v2.0.0** at `~/Documents/frugl/frugl/.specify/memory/constitution.md` (the CLI inherits per the README pointer; the local `.specify/memory/constitution.md` is a placeholder).

| Principle                                                               | Applies                         | Gate evaluation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I. Waste-Reduction Orientation**                                      | yes (indirectly)                | CLI is the only ingest path. Without it the cloud product can pull no waste levers. Every line of the CLI's surface serves that ingest. ✅ **Pass**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **II. Multi-Tenant by Construction**                                    | yes                             | CLI uploads to per-user prefixes via server-minted **short-lived presigned URLs** (FR-022/023); it does NOT hold long-lived bucket credentials. Tokens live only in the OS keychain (FR-004); no fallback to plaintext (FR-005). Cross-tenant isolation is enforced server-side by the cloud's RLS + bucket policy; the CLI's job is to never bypass either. ✅ **Pass**                                                                                                                                                                                                                                                           |
| **III. Astro + React Islands + Supabase Auth**                          | partial                         | "Supabase Auth as the only identity provider" applies. The CLI uses the cloud's HTTP OTP endpoints (which are backed by Supabase Auth server-side); per **research.md R-10**, the CLI itself does NOT embed `@supabase/supabase-js`. This removes a heavy bundled dep from a public-OSS audited binary and aligns with the constitution's "server endpoints handle every authenticated read or write." ✅ **Pass**                                                                                                                                                                                                                 |
| **IV. shadcn Primitives + Semantic Tokens**                             | n/a                             | UI principle; CLI has no React surface. ✅ **N/A**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **V. Pre-Commit Gates + Local Parity**                                  | yes                             | `oxlint`, `oxfmt`, `tsc --noEmit`, `vitest run` are wired into the `pre-commit` hook in `package.json`. `--no-verify` is forbidden by constitution; no plan task may bypass it. SC-004 (full loop runs against local Docker stack with zero external creds, also in CI) directly satisfies the Local Parity half. ✅ **Pass**                                                                                                                                                                                                                                                                                                      |
| **VI. Fail-Closed Anonymization, IaC Source-of-Truth, Honest Failures** | yes (primary gate for this CLI) | • **Fail-closed anonymization** — FR-009 (every byte through anonymizer), FR-014 (fail-closed default), FR-015 (abort batch on single-session anonymization failure), FR-017 (every manifest carries `redaction_policy_version`), SC-001 (planted-secrets fixture in CI). ✅ • **IaC source of truth** — N/A; CLI owns no AWS resources. ✅ N/A • **Honest failures** — FR-029b (no retry on 4xx/426), FR-029c (preserve resume state on transient failure exit), FR-037 (distinct stable exit codes per failure mode), FR-038/039/040 (no silent degradation; explicit JSON contracts), FR-034 (no silent telemetry). ✅ **Pass** |

**Result**: No constitutional violations. No Complexity Tracking entries required.

**Post-Phase-1 re-check**: The contracts and data model below introduce no new gate concerns. The recorded `zod` schemas in `contracts/` are the mechanism by which "Honest failures" extends to cross-repo drift detection (Principle VI). Result still: ✅ **Pass**.

## Project Structure

### Documentation (this feature)

```text
specs/001-cli-ingest-client/
├── plan.md              # This file (/speckit-plan output)
├── spec.md              # Feature specification (already authored)
├── research.md          # Phase 0 output — decision log for everything not locked in spec
├── data-model.md        # Phase 1 output — internal entity shapes
├── quickstart.md        # Phase 1 output — contributor / verifier walk-through
├── contracts/           # Phase 1 output — public contract surface (FR-036)
│   ├── cloud-api.md
│   ├── manifest.schema.json
│   ├── redaction-summary.schema.json
│   ├── progress-event.schema.json
│   ├── command-output.schema.json
│   └── exit-codes.md
├── checklists/          # Pre-existing (from /speckit-clarify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

Single-package CLI. The existing `src/` scaffold is migrated in place; no new packages, no monorepo split. Co-located `*.test.ts` is the existing convention (`vitest.config.ts` already configured for `src/**/*.{test,spec}.ts`) and is preserved.

```text
frugl-cli/
├── bin/
│   ├── run.js                 # oclif production entrypoint (replaces src/cli.ts shebang)
│   └── dev.js                 # oclif tsx-based dev entrypoint
├── src/
│   ├── commands/              # oclif Command classes (one per user-facing verb)
│   │   ├── login.ts           # FR-001 — email + OTP via @inquirer/prompts → cloud
│   │   ├── logout.ts          # FR-002
│   │   ├── whoami.ts          # FR-003
│   │   └── upload.ts          # FR-006 .. FR-029 (orchestrator only; logic lives in modules below)
│   ├── auth/
│   │   ├── keychain.ts        # @napi-rs/keyring wrapper (FR-004/005)
│   │   └── otp-flow.ts        # OTP request + verify against cloud HTTP endpoints
│   ├── anonymize/             # THE TRUST GATE — runs before any byte leaves
│   │   ├── index.ts           # public anonymize() API (existing)
│   │   ├── policy.ts          # POLICY_VERSION string + ruleset metadata (FR-017)
│   │   ├── pseudonyms.ts      # per-upload-stable pseudonym table (FR-016)
│   │   ├── rules/
│   │   │   ├── secrets.ts     # FR-010 — Anthropic/OpenAI/AWS/GCP/GitHub/Slack/.env
│   │   │   ├── claude-paths.ts# FR-011 — $HOME paths, project/dir names
│   │   │   ├── emails.ts      # FR-011/012 — owner preserved, others pseudonymized
│   │   │   └── entropy.ts     # FR-013 — Shannon entropy fallback (≥20 chars, ≥4.5 bits/char)
│   │   └── *.test.ts          # planted-secrets fixtures (SC-001)
│   ├── sources/               # FR-007 open extension point
│   │   ├── types.ts           # Source interface (discover, parse, deriveIdentity)
│   │   ├── registry.ts        # built-in sources; v1: [claudeCode]
│   │   └── claude-code/
│   │       ├── discover.ts    # ~/.claude/projects/**/*.jsonl via tinyglobby
│   │       ├── identity.ts    # FR-006b — read sessionId from JSONL, fallback to path-hash
│   │       └── parse.ts       # JSONL → in-memory session shape
│   ├── ledger/                # FR-006c..g local upload ledger
│   │   ├── ledger.ts          # conf-backed; key = (endpoint, user)
│   │   ├── classify.ts        # FR-006d — unchanged | new | updated
│   │   └── *.test.ts
│   ├── upload/                # FR-022 .. FR-029 pipeline
│   │   ├── pipeline.ts        # p-limit (default 4) + p-retry per session PUT
│   │   ├── resume.ts          # FR-026/027/027a/027b/027c resume state
│   │   ├── summary.ts         # FR-020/020a/020b pre-upload summary builder
│   │   ├── progress.ts        # FR-038/039 — stderr human + stdout NDJSON
│   │   └── *.test.ts
│   ├── cloud/                 # HTTP boundary to the cloud API
│   │   ├── client.ts          # native fetch + CLI-version header (FR-032) + timeout
│   │   ├── schemas.ts         # zod schemas for every response (FR-036 contract)
│   │   ├── version-gate.ts    # FR-033 — semver compare on 426
│   │   └── endpoints.ts       # default vs --endpoint vs FRUGL_ENDPOINT (FR-030/031)
│   ├── lib/
│   │   ├── exit-codes.ts      # FR-037 — frozen exit-code table
│   │   ├── errors.ts          # typed error classes, each mapped to an exit code
│   │   ├── paths.ts           # env-paths resolution for conf namespaces
│   │   ├── retry.ts           # p-retry wrapper with FR-029a/b predicate
│   │   └── output-mode.ts     # --json toggle threaded through commands (FR-040)
│   └── index.ts               # oclif runtime glue (re-export Commands; oclif discovers them)
├── package.json               # oclif metadata in `oclif:` key; updated deps
├── tsconfig.json              # unchanged
├── vitest.config.ts           # unchanged
├── .oxlintrc.json             # unchanged
└── ... (LICENSE, README, etc.)
```

**Structure Decision**: Single-project layout, preserving the existing `src/`-rooted convention with co-located `*.test.ts`. Each subdirectory of `src/` maps to one well-scoped concern (auth, anonymize, sources, ledger, upload, cloud, lib). The `src/sources/` registry is the explicit FR-007 seam for future source adapters as separate files (and, later, as separate oclif plugin packages when spec `004-sources` lands). The `src/commands/` directory follows oclif's auto-discovery convention — each Command class in its own file. No second project, no workspace split: the constitution's Principle V (`format`, `lint`, `typecheck`, `test` gate) is easier to enforce against one buildable package.

### Migration of existing scaffold (executed during Phase 2 `/speckit-implement`, listed here for completeness)

- **Remove**: `commander`, `prompts`, `keytar`, `@supabase/supabase-js`, `@types/prompts` from `package.json` dependencies.
- **Add**: `@oclif/core`, `oclif`, `@inquirer/prompts`, `@napi-rs/keyring`, `zod`, `semver`, `p-retry`, `p-limit`, `conf`, `env-paths`, `tinyglobby`, `picocolors`.
- **Replace**: `src/cli.ts` (commander) → `bin/run.js` + `src/index.ts` (oclif). Each `src/commands/*.ts` file converts from `new Command(...)` to a class extending `@oclif/core` `Command`.
- **Delete**: `src/commands/delete.ts` (deferred to spec `002-delete`, per spec.md Assumptions).
- **Keep**: `src/anonymize/index.ts` (stub) and `src/anonymize/anonymize.test.ts` (currently `describe.todo` — flipped to live tests during Phase 2 as rules land).
- **Keep**: `src/auth/keychain.ts` API surface (`getToken`/`setToken`/`deleteToken`/`SERVICE`); only the implementation backend changes (`keytar` → `@napi-rs/keyring`).

## Complexity Tracking

> No Constitution Check violations. Section intentionally empty.

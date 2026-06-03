# Implementation Plan: frugl-cli PR-link metadata — opt-in per-session git context at upload time

**Branch**: `005-cli-pr-metadata` | **Date**: 2026-05-24 | **Spec**: [./spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-cli-pr-metadata/spec.md`

## Summary

This feature is the **producer half** of the cloud's PR-linking / merge-rate waste lever (cloud `005` FR-024/FR-028). It adds an **opt-in** `--link-prs` flag to `frugl upload` that, for each session in the `(new ∪ updated)` upload batch, resolves a small forge-agnostic git coordinate — `{ repository: { host, owner, name }, branch?, commitSha }` — **read-only** from the session's recorded working directory and attaches it to that session's manifest entry as strictly-additive metadata. With the flag absent, `frugl upload` is byte-for-byte unchanged from `001`.

The technical approach reuses the `001` pipeline wholesale and inserts one new, well-scoped module, `src/upload/git-context.ts`. It derives the repository root by walking up from each session's `cwd` (which the Claude Code source records natively per JSONL record), reads `origin` from `.git/config`, strips any embedded credentials to host + `owner/name`, reads the branch (preferring the session-recorded `gitBranch` per FR-006, else current ref) and the full `HEAD` commit SHA — all by reading files under `.git/` directly, executing **no** git binary and therefore **no** repository hooks. Resolution is best-effort and non-fatal (FR-008/009): any session that cannot be resolved simply carries no git context, and the batch proceeds.

The crux is the privacy posture. Repository identity and branch names are exactly the class of identifying data the `001` anonymizer redacts by default (`001` FR-011). Transmitting them is a **deliberate, opt-in departure** from fail-closed redaction, made safe by three guarantees this plan threads through every layer: (1) the flag is **off by default** with a provably unchanged default path (FR-001/002, SC-001); (2) credential-stripping is **fail-closed** — an unparseable remote yields _no_ identity rather than an unsanitised string (FR-005/015, SC-003); and (3) the exact metadata is **auditable before send** in the pre-upload summary and `--dry-run --inspect` output (FR-013/014, SC-004). Git context is attached as manifest metadata **outside** the anonymized payload, so it never passes through the anonymizer and never changes the `redactedHashHex` the incremental ledger keys on (FR-011, SC-007) — toggling `--link-prs` cannot churn the ledger.

Key insight grounding the plan: the live Claude Code JSONL format already records `cwd` and `gitBranch` on its message records. The `001` `claude-code` source parses these lines but does not surface either field; this feature extends the source's parse output and `ParsedSession` shape additively to expose them, then derives git context from `cwd` (and uses `gitBranch` to satisfy FR-006's "prefer the branch the session recorded at work time").

## Technical Context

**Language/Version**: TypeScript 6.x, Node.js ≥ 20 (inherited from `001` plan.md; no change).

**Primary Dependencies**: No new runtime dependencies. Git inspection uses Node built-ins only:

- `node:fs` / `node:fs/promises` — read `.git/config`, `.git/HEAD`, `.git/refs/**`, `.git/packed-refs`; `fs.stat` to detect a working directory that no longer exists (FR-008 edge case).
- `node:path` — resolve and walk parent directories to locate the enclosing `.git` (mirrors how git itself ascends; spec Edge Cases "subdirectory" case).
- `node:url` — parse `https://`/`ssh://` remote URLs to extract and **discard** any `userinfo` (credential) component before recording host + `owner/name` (FR-005).

No spawning of a `git` subprocess (see research.md R-2): reading the ref files directly guarantees zero hooks, zero index/worktree/ref mutation (spec Edge Cases "must not trigger side effects", FR-004), and removes a dependency on `git` being installed (FR-009 degradation becomes a clean "git refs unreadable" path, not a missing-binary exception).

**Storage**:

- **No new persisted state by default.** Git context is computed in-memory per upload and attached to the manifest; it is never written to the ledger or resume state.
- **Optional opt-in config (FR-003)**: one additional key, `linkPrs: boolean` (default `false`), in a `conf`-backed `frugl-config` namespace under the existing env-paths state dir (`src/lib/paths.ts`). When both the persisted setting and the explicit flag are present, the explicit flag wins. This is the only net-new persistence and it holds no repository data — just the boolean preference.

**Testing**: vitest, co-located `*.test.ts` (the `001`/existing convention). Three tiers, mirroring `001`:

- **Unit** — credential-stripping / URL-normalization fixture (SC-003: https-with-token, ssh-with-user, scp-style `git@host:owner/name`, unparseable → omit); repo-root ascent; branch/commit reading from a temp `.git` fixture; detached-HEAD → commit-only.
- **Contract** — the produced `gitContext` validates against the extended manifest schema; a `001`-era consumer that ignores `gitContext` parses the manifest identically (SC-006 backward-compat).
- **Integration** — default-off reads/sends nothing even when sessions are inside real repos (SC-001, filesystem spy + network spy); ledger non-churn across a no-flag → `--link-prs` re-run (SC-007); `--dry-run --inspect` writes the exact context and transmits zero bytes (SC-004).

**Target Platform**: Cross-platform — macOS, Windows, Linux on Node ≥ 20 (inherited). `.git` ref-file reading is platform-neutral; path ascent uses `node:path` so Windows separators are handled.

**Project Type**: Single-package CLI (inherited from `001`). No workspace change.

**Performance Goals**: Git resolution adds bounded per-session work proportional to the `(new ∪ updated)` batch only (FR-004, applied _after_ `--limit` per `001` FR-006a). Each resolution is a handful of small file reads. Repo-root lookups are memoised per distinct `cwd` within an invocation so a batch of sessions sharing one repo reads `.git/config` once. Resolution for a batch is O(distinct repos) file reads, not O(sessions); negligible against the `001` SC-003 60 s first-upload budget.

**Constraints**:

- **Privacy posture (Principle VI + spec crux)**: default-off is byte-for-byte the `001` path (FR-001/002); credential-stripping is fail-closed (FR-005/015); every value that leaves the machine is auditable pre-send (FR-013/014). Git context is the one thing the CLI transmits that is _not_ run through the redactor, so it is gated behind explicit opt-in and mandatory visibility.
- **Read-only / no side effects (FR-004)**: inspection reads files under `.git/` only; never invokes a process, never writes, never runs a hook.
- **Ledger invariance (FR-011, `001` FR-006c)**: git context is manifest metadata, not payload; it is excluded from the bytes hashed into `redactedHashHex`. Enabling/disabling the flag cannot reclassify an unchanged session.
- **Contract surface (FR-010/012/016, `001` FR-036)**: the `gitContext` object on `ManifestEntry`, plus the additive `upload-start`/final-summary `--json` fields, are public contracts; non-additive change requires the coordinated cross-repo bump with `frugl/005`.
- **No new exit codes (spec Assumptions)**: best-effort derivation never fails the upload, so no failure mode or exit code is added beyond the `001`/`004` table.

**Scale/Scope**:

- v1 surface change = one new boolean flag (`--link-prs`) on `upload`, plus its optional persisted-config equivalent. No new command.
- v1 source that yields a working directory = `claude-code` (records `cwd`/`gitBranch` natively). Future source adapters define their own working-directory derivation (`001` FR-007); the git-context module consumes a `cwd: string | undefined` regardless of source.
- Forge-agnostic by construction (host + `owner/name`); the CLI records every host and never filters (spec Edge Cases "non-GitHub remote").

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

The applicable constitution is **Frugl Cloud Constitution v2.0.0** at `~/Documents/frugl/frugl/.specify/memory/constitution.md` (the CLI inherits per the README pointer; the local `.specify/memory/constitution.md` is a placeholder). This feature touches the **privacy / fail-closed / honest-failures** principle most directly, because it deliberately transmits data the anonymizer normally redacts — so that principle is the primary gate.

| Principle                                                               | Applies                     | Gate evaluation                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I. Waste-Reduction Orientation**                                      | yes (directly)              | This is the CLI half of the cloud's headline "did this AI spend ship as a merged PR?" waste lever (cloud `005` US5 / FR-028). Without the CLI attaching the metadata, the cloud's merge-rate and cost-to-merge surfaces have nothing to join on. ✅ **Pass**                                      |
| **II. Multi-Tenant by Construction**                                    | yes (no new attack surface) | Git context rides the existing per-user, presigned-URL upload path (`001` FR-022/023); it adds no new credential, no new endpoint, no cross-tenant read. The metadata is scoped to the authenticated user's own manifest. ✅ **Pass**                                                             |
| **III. Astro + React Islands + Supabase Auth**                          | n/a                         | Identity-provider/web principle; CLI has no React surface and adds no auth path. ✅ **N/A**                                                                                                                                                                                                       |
| **IV. shadcn Primitives + Semantic Tokens**                             | n/a                         | UI principle; CLI has no React surface. ✅ **N/A**                                                                                                                                                                                                                                                |
| **V. Pre-Commit Gates + Local Parity**                                  | yes                         | `oxlint`, `oxfmt`, `tsc --noEmit`, `vitest run` remain the gate (`001` wired them into `pre-commit`); every new module + test obeys it. `--no-verify` forbidden. SC-001/SC-004/SC-006/SC-007 tests run against fixtures with no external network dependency, satisfying Local Parity. ✅ **Pass** |
| **VI. Fail-Closed Anonymization, IaC Source-of-Truth, Honest Failures** | yes (**primary gate**)      | This is the principle the feature must justify against, because it sends repo identity the anonymizer would otherwise redact. See the dedicated analysis below. ✅ **Pass (with justification)**                                                                                                  |

### Principle VI deep-dive (the gate that matters for this feature)

The constitution's fail-closed anonymization rule says "any field above documented entropy/length thresholds, or matching uncertain provider patterns, is redacted by default." Repository `owner/name` and branch names are squarely that class of data. Transmitting them is a **deliberate departure**. The plan satisfies the principle's underlying posture — _fail safely when you don't know, and never surprise the user_ — through four mechanisms, each mapped to a requirement and a test:

1. **Opt-in, default-off (FR-001/002 → SC-001).** The departure happens only on explicit, informed consent. The default path performs **zero** repository reads and attaches **zero** git fields — provably, via a filesystem spy asserting no `.git` access and a network spy asserting no git fields in any request body, _even when sessions were worked inside git repos_. This is the byte-for-byte `001` behaviour. A redaction departure that the user did not ask for cannot occur.
2. **Fail-closed credential-stripping (FR-005/015 → SC-003).** The one genuinely dangerous value — a token embedded in a remote URL — is stripped to host + `owner/name` before anything is recorded. If a URL cannot be parsed into a clean host + `owner/name`, the CLI records **no** identity rather than risk an unsanitised string. This is the same fail-closed-on-uncertainty discipline the anonymizer uses, applied to the one un-redacted field.
3. **Auditable before send (FR-013/014 → SC-004).** Because git context is the one thing the CLI sends _without_ running it through the redactor, the user can see exactly what will leave the machine: the pre-upload summary names the repositories and counts; `--dry-run --inspect` writes the per-session context distinctly from (and clearly labelled apart from) the redacted payload, and transmits zero bytes. This preserves the `001` US2 trust contract.
4. **Honest failures, no silent degradation (FR-008/009).** Resolution is best-effort: a session that can't be resolved silently carries no context (matching the cloud's own "no PR metadata → excluded from denominator" contract, cloud `005` Edge Cases), but the two _global_ degradations the user should know about — "git unavailable on host" and "flag on, but zero sessions resolved" — emit **one** clear informational notice each (FR-009 / US4 scenario 4). No exceptions are swallowed silently; no speculative abstraction is introduced.

This is not an unjustifiable violation — it is the principle working as designed: the system departs from the safe default **only** with explicit consent, **only** for a fail-closed-sanitised value, and **only** in a way the user can audit before any byte leaves. **No ERROR.** No Complexity Tracking entry required.

**Post-Phase-1 re-check**: The data model and contracts below introduce only an _optional, additive_ `gitContext` property on `ManifestEntry` (`additionalProperties` stays `false` by _adding_ the property to the schema, not by relaxing the constraint), plus additive `--json` fields. They create no new gate concern; the manifest extension is the mechanism by which "Honest failures" extends to cross-repo drift detection for the new field (a malformed `gitContext` fails the same `zod`-validated contract path as any other `001` contract). Result still: ✅ **Pass**.

## Project Structure

### Documentation (this feature)

```text
specs/005-cli-pr-metadata/
├── plan.md              # This file (/speckit-plan output)
├── spec.md              # Feature specification (already authored)
├── research.md          # Phase 0 output — decision log (this run)
├── data-model.md        # Phase 1 output — gitContext internal shape + attach points
├── quickstart.md        # Phase 1 output — verifier walk-through (default-off, opt-in, inspect, no-leak)
├── contracts/           # Phase 1 output — strictly-additive contract surface
│   ├── manifest-gitcontext.md                 # narrative: how gitContext extends the 001 manifest additively
│   ├── manifest-entry.gitcontext.schema.json  # JSON-schema fragment: optional gitContext on ManifestEntry
│   └── progress-event.gitcontext.md           # additive --json upload-start + final-summary fields
├── checklists/
│   └── requirements.md  # Pre-existing (from /speckit-clarify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

Single-package CLI. This feature adds **one** new module and makes small, additive edits to existing ones. The `001` structure is otherwise unchanged. New/changed files marked below.

```text
frugl-cli/
├── src/
│   ├── commands/
│   │   └── upload.ts            # EDIT — add --link-prs flag (FR-001); resolve opt-in (flag > config, FR-003);
│   │                            #        when active, resolve git context for the willUpload batch (FR-004);
│   │                            #        thread it into summary, inspection writer, jobs, and progress
│   ├── upload/
│   │   ├── git-context.ts       # NEW — the whole feature core: locate repo root from cwd, read origin,
│   │   │                        #        strip credentials → host+owner/name (FR-005), read branch+HEAD
│   │   │                        #        read-only with no hooks (FR-004/007), best-effort (FR-008/009)
│   │   ├── git-context.test.ts  # NEW — SC-002 (resolution), SC-003 (credential fail-closed), graceful degrade
│   │   ├── summary.ts           # EDIT — additive: PR-linking on/off line, sessions-with-context count,
│   │   │                        #        distinct repository list (FR-013); credential-/path-free (FR-015)
│   │   ├── progress.ts          # EDIT — additive: gitContext on upload-start event + batch count (FR-016)
│   │   └── pipeline.ts          # EDIT — additive: pass per-session gitContext into manifest-create body as
│   │                            #        metadata; MUST stay out of redactedHashHex (FR-011, no ledger churn)
│   ├── sources/
│   │   ├── types.ts             # EDIT — additive: optional `cwd?`, `recordedBranch?` on ParsedSession
│   │   └── claude-code/
│   │       └── parse.ts         # EDIT — additive: surface `cwd` + `gitBranch` from JSONL records (FR-006)
│   ├── cloud/
│   │   └── schemas.ts           # EDIT — additive: optional git_context on manifestEntryRequestSchema
│   └── lib/
│       └── config.ts            # NEW (optional, FR-003) — conf-backed frugl-config; linkPrs:boolean default false
└── specs/005-cli-pr-metadata/contracts/   # the public contract extension (see tree above)
```

**Structure Decision**: Single-project layout, preserving the `001` `src/`-rooted convention with co-located `*.test.ts`. The feature's logic is deliberately concentrated in **one** new module — `src/upload/git-context.ts` — because (a) it keeps the auditable surface of "what reads the disk for repo identity" in a single reviewable file, which matters for a trust-gate CLI, and (b) it isolates the one piece of code that produces un-redacted-but-transmitted data so a reviewer can verify the credential-stripping fail-closed path in isolation. Every other change is a small, additive edit at an existing seam: the source surfaces `cwd`/`gitBranch` (parse), the orchestrator gates and wires it (upload command), the summary/inspection/progress make it auditable, and the pipeline attaches it as manifest metadata strictly outside the payload. No new command, no new endpoint, no second project.

## Complexity Tracking

> No Constitution Check violations. The Principle VI departure (transmitting normally-redacted repo identity) is justified in the Constitution Check deep-dive above as opt-in + fail-closed + auditable, which is the principle operating as designed — not a violation. Section intentionally empty.

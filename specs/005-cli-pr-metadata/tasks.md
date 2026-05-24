# Tasks: poppi-cli PR-link metadata — opt-in per-session git context at upload time

**Input**: Design documents from `/specs/005-cli-pr-metadata/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story. Because this feature's central guarantee is *default-off changes nothing*, the foundational phase delivers the opt-in gate and the resolver before any story wires them, and **User Story 2 (default-off)** is verified first — it must pass before User Story 1's opt-in path is trusted. Tests are written before the implementation they cover, matching `001/tasks.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to ([US1]–[US4]); non-story tasks are foundational/polish
- Each description includes the exact target file path

---

## Phase 1: Setup (additive seams, no behaviour change)

**Purpose**: Open the additive seams the feature attaches to, without changing any default-path behaviour. These are prerequisites for every subsequent phase and are all strictly additive (`001` stays byte-for-byte unchanged until US1 wiring lands).

- [ ] T001 [P] Extend `ParsedSession` in src/sources/types.ts with optional `cwd?: string` and `recordedBranch?: string` (additive; existing consumers unaffected) per data-model.md §4 / FR-004 / FR-006 in src/sources/types.ts
- [ ] T002 [P] Surface `cwd` and `gitBranch` in src/sources/claude-code/parse.ts: scan records for the first non-empty `cwd` and first non-empty `gitBranch`, set `ParsedSession.cwd` / `recordedBranch`; do NOT add them to `records` (so they never enter the anonymizer/payload) per data-model.md §4 / FR-004 / FR-006 / FR-011 in src/sources/claude-code/parse.ts
- [ ] T003 [P] Add an optional `git_context` field to `manifestEntryRequestSchema` in src/cloud/schemas.ts (snake_case wire shape: `{ repository: { host, owner, name }, branch?, commit_sha }`); strictly additive — existing required fields unchanged per contracts/manifest-gitcontext.md §1 / FR-010 in src/cloud/schemas.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The opt-in gate, the persisted config, and the read-only git-context resolver — the cross-cutting infrastructure every user story depends on. The resolver is the one module that produces un-redacted-but-transmitted data, so it is built and unit-tested in isolation here.

**⚠️ CRITICAL**: No user story wiring can begin until this phase is complete.

- [ ] T004 [P] Create src/lib/config.ts: `conf`-backed `poppi-config` namespace under the env-paths state dir (reuse src/lib/paths.ts); `zod`-validated `PoppiConfig { schemaVersion: 1, linkPrs: boolean }` default `linkPrs:false`; `getLinkPrs()` / `setLinkPrs(bool)`; schema-version mismatch or missing file → defaults (never a failure) per data-model.md §7 / FR-003 in src/lib/config.ts
- [ ] T005 [P] Write src/lib/config.test.ts: default is `linkPrs:false`; round-trip set/get; schema-version mismatch → defaults not error; config holds only the boolean (no repo data) per FR-003 in src/lib/config.test.ts
- [ ] T006 Create src/upload/git-context.ts — the resolver core. Export `resolveGitContext(input: { cwd?: string; recordedBranch?: string }): Promise<GitContextResolution>` returning `{kind:"resolved"|"unresolved"|"git-unavailable"}` per data-model.md §1–2. Implement, reading `.git/` files ONLY (no `git` subprocess, no hooks — FR-004/R-2):
  - repo-root ascent from `cwd` (handle `.git` dir and `gitdir:` pointer file; memoise per cwd) per R-3
  - `origin` selection + URL parse + credential strip → `{host, owner, name}`, fail-closed omit on unparseable (FR-005/R-4)
  - branch: prefer `recordedBranch`, else `.git/HEAD` ref; detached HEAD → omit branch (FR-006/R-5)
  - commit: resolve full 40-hex HEAD via loose ref then `.git/packed-refs`, or raw SHA in HEAD (FR-007/R-5)
  - NEVER throw: every failure path returns `unresolved`/`git-unavailable` (FR-008/009/R-8)
  in src/upload/git-context.ts
- [ ] T007 [P] Add a per-invocation opt-in resolver helper (`EffectiveLinkPrs`) — explicit `--link-prs` flag wins, else persisted `linkPrs` config, else `false`; record `source: 'flag'|'config'|'default'` per data-model.md §3 / FR-001 / FR-003 / R-7 (co-locate in src/commands/upload.ts or a small src/upload/link-prs.ts helper) in src/commands/upload.ts

**Checkpoint**: Resolver + opt-in gate + config exist and are unit-testable; nothing is wired into the default upload path yet, so `001` behaviour is still byte-for-byte unchanged.

---

## Phase 3: User Story 2 — Default is off, nothing leaks (Priority: P1) 🎯 the safety gate

**Goal**: Prove and lock the default-off guarantee: with no `--link-prs`, the resolver is never entered, no `.git` is read, and no git field is attached or emitted — even when sessions were worked inside git repos. This phase must pass before US1's opt-in path is trusted.

**Independent Test**: Run `poppi upload` (no `--link-prs`) against a mock server recording every request body, with a session whose `cwd` is a real git repo. Assert: no manifest entry contains any git field, and a filesystem spy records zero `.git` reads. The absence of git context is identical to a session worked outside any repo.

### Tests for User Story 2 (write first, must FAIL before wiring) ⚠️

- [ ] T008 [P] [US2] Write src/upload/git-context.default-off.test.ts (SC-001): with the opt-in OFF, assert `resolveGitContext` is never called by the upload path; install a filesystem spy on `.git` reads and assert zero hits even when a session's `cwd` is a real repo fixture; assert no request body / manifest entry carries any git field per FR-001 / FR-002 / SC-001 in src/upload/git-context.default-off.test.ts

### Implementation for User Story 2

- [ ] T009 [US2] Gate the resolver hard in src/commands/upload.ts: when `EffectiveLinkPrs.active === false`, do NOT call `resolveGitContext`, do NOT read `cwd`/`.git`, do NOT attach or emit any git field — the resolver is unreachable on the default path per data-model.md §3 / FR-002 / SC-001 in src/commands/upload.ts
- [ ] T010 [US2] In src/upload/summary.ts, render `PR linking: off` (or omit the git line) when the opt-in is inactive; ensure the default-path summary is otherwise byte-for-byte `001` per FR-002 (scenario 2) in src/upload/summary.ts

**Checkpoint**: Default-off is provable (SC-001 passes). The opt-in path can now be wired knowing it cannot affect the default path.

---

## Phase 4: User Story 1 — Opt in to link sessions to PRs (Priority: P1) 🎯 MVP

**Goal**: With `--link-prs`, resolve git context for each `(new ∪ updated)` session, attach it as additive manifest metadata, and surface it in the pre-upload summary. After upload, sessions become linkable once the team connects GitHub.

**Independent Test**: A session whose recorded `cwd` is a clean checkout with a GitHub `origin` on a feature branch, run with `poppi upload --link-prs` against the local stack, produces a manifest whose entry carries the correct `owner/name`, branch, and 40-hex commit. The same session without `--link-prs` carries none.

### Tests for User Story 1 (write first, must FAIL before implementation) ⚠️

- [ ] T011 [P] [US1] Extend src/upload/git-context.test.ts with the resolution matrix (SC-002): clean repo + origin on a feature branch → correct `host/owner/name` + recorded branch + 40-hex commit; subdirectory `cwd` → enclosing repo (R-3); multiple remotes → prefers `origin`; non-GitHub host recorded unfiltered; detached HEAD → branch omitted, commit present per FR-004/005/006/007 / SC-002 in src/upload/git-context.test.ts
- [ ] T012 [P] [US1] Write src/upload/git-context.credentials.test.ts (SC-003): fixture of `origin` URLs embedding credentials (https-with-token, ssh-with-user, scp-style `git@host:owner/name`) → recorded identity is host + `owner/name` only, 0% contain the planted token; an unparseable URL → `unresolved` (NO partial identity, fail-closed) per FR-005 / FR-015 / SC-003 in src/upload/git-context.credentials.test.ts
- [ ] T013 [P] [US1] Write a manifest contract test (SC-006) asserting a produced `gitContext` validates against specs/005-cli-pr-metadata/contracts/manifest-entry.gitcontext.schema.json, AND a manifest with `gitContext` parses identically under a consumer that ignores it (backward-compatible vs. `001` manifest.schema.json) in src/cloud/manifest-gitcontext.contract.test.ts

### Implementation for User Story 1

- [ ] T014 [US1] Add the `--link-prs` boolean flag (default false) to src/commands/upload.ts flags; wire `EffectiveLinkPrs` (T007) and surface the opt-in in `--help`; ensure `--link-prs` parses alongside existing flags per FR-001 / FR-003 in src/commands/upload.ts
- [ ] T015 [US1] In src/commands/upload.ts, when the opt-in is active, resolve git context for the `willUpload` batch ONLY (after `--limit` truncation, `001` FR-006a): for each session call `resolveGitContext({ cwd, recordedBranch })` using the parsed session's `cwd`/`recordedBranch`; memoise per distinct `cwd`; collect results per FR-004 (spec Edge Cases `--limit`) in src/commands/upload.ts
- [ ] T016 [US1] Attach resolved git context as manifest metadata in src/upload/pipeline.ts: thread an optional `gitContext` through `SessionUploadJob`; include it as `sessions[].git_context` in the manifest-create body; ensure it is EXCLUDED from the payload PUT and from `redactedHashHex`/`contentHash` per FR-010 / FR-011 / data-model.md §5 in src/upload/pipeline.ts
- [ ] T017 [US1] Extend src/upload/summary.ts (and `UploadSummary`) with `prLinking { active, source, sessionsWithContext, repositories[] }`; `formatSummaryForHuman` prints `PR linking: on (from flag|config)`, the `N of M` count, and the distinct repo list — credential-/path-free per FR-013 / FR-015 / data-model.md §6 in src/upload/summary.ts

**Checkpoint**: `poppi upload --link-prs --confirm` attaches correct context to the manifest; the summary names repos and counts; the same run without the flag attaches none.

---

## Phase 5: User Story 3 — Audit before any byte is sent (Priority: P1)

**Goal**: `--link-prs --dry-run --inspect` writes the exact per-session git context that would be transmitted, distinctly from the redacted payload, and transmits zero bytes.

**Independent Test**: For a batch across two repos, `poppi upload --link-prs --dry-run --inspect <dir>` writes every would-be-transmitted git-context value in human-readable form, makes zero upload-endpoint requests, and a textual search for a planted credential token returns zero hits.

### Tests for User Story 3 (write first, must FAIL before implementation) ⚠️

- [ ] T018 [P] [US3] Write src/commands/upload.inspect-gitcontext.test.ts (SC-004): `--link-prs --dry-run --inspect <tmp>` writes, per session, the git context that would be transmitted; assert 100% of resolved values appear in the inspection output; a network spy asserts ZERO upload-endpoint hits; a planted credential token appears nowhere in the output (SC-003 ∩ SC-004) per FR-014 / FR-015 in src/commands/upload.inspect-gitcontext.test.ts

### Implementation for User Story 3

- [ ] T019 [US3] Extend the inspection writer in src/commands/upload.ts (`writeInspectionDir`): when the opt-in is active, write per-session git context (e.g. a `git-context.json` sidecar and/or a labelled per-session block) DISTINCT from the redacted `*.payload.json`, clearly marked "intentionally sent in clear — opt-in, NOT redacted"; never write any `cwd`/absolute path/credential per FR-014 / FR-015 / data-model.md §5 in src/commands/upload.ts
- [ ] T020 [US3] Confirm the `--dry-run` early-return path in src/commands/upload.ts still transmits zero bytes with `--link-prs` active (git resolution is local file reads only; returns before any CloudClient call) per FR-014 (`001` FR-018) in src/commands/upload.ts

**Checkpoint**: A security-conscious user can read exactly what will leave the machine before sending, and confirm zero bytes and zero credential leakage.

---

## Phase 6: User Story 4 — Best-effort graceful degradation (Priority: P2)

**Goal**: A mixed real-world batch completes successfully; only resolvable sessions carry context; no payload upload is dropped; two global notices cover the "nothing resolved" and "git unavailable" cases; no new exit code.

**Independent Test**: A batch with (a) clean repo+remote, (b) not-a-repo, (c) repo with no remote, (d) missing directory, (e) detached HEAD, run with `--link-prs`, exits success; only (a) and (e)'s commit carry context; (b)/(c)/(d) carry none; exit code is success.

### Tests for User Story 4 (write first, must FAIL before implementation) ⚠️

- [ ] T021 [P] [US4] Extend src/upload/git-context.test.ts with the degradation matrix (SC-005): not-a-repo → `unresolved:not-a-repo`; no remote → `unresolved:no-remote`; missing dir → `unresolved:missing-dir`; no cwd → `unresolved:no-cwd`; the resolver NEVER throws on any of these per FR-008 / SC-005 in src/upload/git-context.test.ts
- [ ] T022 [P] [US4] Write src/commands/upload.degradation.test.ts (SC-005): a mixed batch run with `--link-prs` exits success; only resolvable sessions carry context; NO session's payload upload is dropped because git context failed; assert the two global notices fire at most once each ("no sessions had resolvable git context"; "git could not be inspected, proceeding as if off") and both exit success; assert no new exit code is introduced per FR-008 / FR-009 / spec Assumptions in src/commands/upload.degradation.test.ts

### Implementation for User Story 4

- [ ] T023 [US4] In src/commands/upload.ts, treat every `unresolved` session as carrying no context and continue the batch (never drop its payload upload); aggregate resolutions per FR-008 in src/commands/upload.ts
- [ ] T024 [US4] In src/commands/upload.ts, emit the single global notice when `--link-prs` was active but zero sessions resolved (US4 scenario 4), and the single global notice when resolution returned `git-unavailable` wholesale (US4 scenario 5 / FR-009) — both proceed and exit success; introduce NO new exit code per FR-009 / spec Assumptions in src/commands/upload.ts

**Checkpoint**: The flag is usable over a messy month of sessions: graceful, non-fatal, with clear-but-quiet global notices.

---

## Phase 7: Machine-readable output, no-churn lock & polish

**Purpose**: Additive `--json` fields, the ledger-non-churn guarantee, and quickstart validation.

- [ ] T025 [P] Extend the `upload-start` NDJSON event and the final manifest-summary in src/upload/progress.ts and src/commands/upload.ts with the optional `gitContext { active, sessionsWithContext, repositories[] }`; omit entirely when off (preserve byte-for-byte default `--json` stream) per FR-016 / contracts/progress-event.gitcontext.md in src/upload/progress.ts
- [ ] T026 [P] Write the no-ledger-churn test in src/ledger/classify.gitcontext.test.ts (SC-007): upload a session WITHOUT `--link-prs`, populate the ledger; re-run classification WITH `--link-prs`; assert the session classifies `unchanged` and is skipped (its `contentHash`/`redactedHashHex` is unchanged because git context is excluded) per FR-011 / SC-007 in src/ledger/classify.gitcontext.test.ts
- [ ] T027 [P] Write a `--json` additive-contract test asserting the `upload-start` and final-summary `gitContext` fields validate against contracts/progress-event.gitcontext.md shapes and are omitted when off; a `001` consumer ignoring them is unaffected per FR-016 / SC-006 in src/upload/progress.gitcontext.test.ts
- [ ] T028 Run the quickstart.md validation loop against the local stack: default-off (SC-001) → opt-in attaches correct context (SC-002) → `--dry-run --inspect` shows it & sends nothing (SC-004) → planted credential never leaks (SC-003) → toggle does not re-upload (SC-007) → mixed batch degrades gracefully (SC-005); confirm no new exit code per quickstart.md §1–6 in specs/005-cli-pr-metadata/quickstart.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — begin immediately (additive seams)
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user story wiring
- **US2 / Default-off (Phase 3)**: Depends on Phase 2; verified FIRST so the safety gate is locked before the opt-in path is trusted
- **US1 / Opt-in (Phase 4)**: Depends on Phase 3 (default-off must be provable before wiring the opt-in path)
- **US3 / Audit (Phase 5)**: Depends on Phase 4 (inspection writes the context US1 resolves)
- **US4 / Degradation (Phase 6)**: Depends on Phase 4 (extends the resolution wiring from US1)
- **Polish (Phase 7)**: Depends on all story phases

### User Story Dependencies

- **US2 (Default-off)**: Depends only on Foundational — the safety gate; verified before any opt-in wiring
- **US1 (Opt-in)**: Depends on US2 (cannot trust the opt-in path until default-off is proven)
- **US3 (Audit)**: Depends on US1 (audits the context US1 produces)
- **US4 (Degradation)**: Depends on US1 (extends US1's per-session resolution loop)

### Within Each Phase

- Tests marked ⚠️ are written FIRST and must FAIL before the implementation in the same phase
- [P] tasks touch different files and may run concurrently
- The resolver (T006) precedes all wiring; the opt-in gate (T007/T009) precedes any attach (T016)

### Parallel Opportunities

```bash
# Phase 1: all additive seams in parallel
# T001 types.ts | T002 parse.ts | T003 schemas.ts

# Phase 2: config + resolver
# T004 config.ts | T005 config.test.ts | (T006 git-context.ts → then) T007 opt-in helper

# Phase 4: US1 tests in parallel before implementation
# T011 resolution matrix | T012 credentials | T013 contract test
#   then T014 flag → T015 resolve loop → T016 attach → T017 summary

# Phase 7: independent test/polish tasks in parallel
# T025 progress.ts | T026 classify churn test | T027 json contract test
```

---

## Requirement & success-criterion coverage map

| FR / SC | Covered by |
| --- | --- |
| FR-001 (opt-in flag default-off) | T007, T014 |
| FR-002 (off ⇒ zero reads/fields) | T008, T009, T010 |
| FR-003 (persisted opt-in, flag wins) | T004, T005, T007, T014 |
| FR-004 (resolve from recorded cwd, read-only) | T002, T006, T015 |
| FR-005 (host+owner/name, credential strip, fail-closed) | T006, T012 |
| FR-006 (branch: prefer recorded; detached → omit) | T002, T006, T011 |
| FR-007 (full HEAD commit SHA) | T006, T011 |
| FR-008 (best-effort, non-fatal per session) | T006, T021, T022, T023 |
| FR-009 (git unavailable → one notice, proceed) | T006, T022, T024 |
| FR-010 (additive `gitContext` on ManifestEntry) | T003, T013, T016 |
| FR-011 (metadata, not payload; no hash churn) | T002, T016, T026 |
| FR-012 (stable public contract) | T013, T027, contracts/ |
| FR-013 (pre-upload summary names repos/counts) | T017 |
| FR-014 (`--dry-run --inspect` shows it, sends nothing) | T018, T019, T020 |
| FR-015 (no credential/path in any output) | T010, T012, T017, T019 |
| FR-016 (additive `--json` event + summary) | T025, T027 |
| SC-001 (default-off provable) | T008 |
| SC-002 (opt-in completeness ≥95%) | T011 |
| SC-003 (credential safety, fail-closed) | T012, T018 |
| SC-004 (auditable before send, 0 bytes) | T018, T020 |
| SC-005 (graceful degradation) | T021, T022 |
| SC-006 (additive, backward-compatible) | T013, T027 |
| SC-007 (no ledger churn) | T026 |

---

## Notes

- [P] tasks = different files, no intra-phase dependencies; safe to run concurrently
- [Story] label maps each task to a user story for traceability against spec.md
- Tests come first within each phase and must fail before the implementation lands (matching `001/tasks.md`)
- The pre-commit gate (format + lint + typecheck + test) must pass before every commit; `--no-verify` is forbidden by constitution Principle V
- This feature introduces NO new exit code (spec Assumptions); best-effort derivation is never fatal
- Every default-path assertion (SC-001) is release-relevant: a regression that leaks repo identity without `--link-prs` is a privacy incident, the same severity class as an anonymizer gap (Principle VI)

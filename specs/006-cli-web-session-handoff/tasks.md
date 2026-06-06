# Tasks: CLI-to-Web Session Handoff

**Input**: Design documents from `/specs/006-cli-web-session-handoff/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/handoff-api.md, quickstart.md

**Tests**: Included — research R-10 locks a three-tier test strategy and constitution Principle V gates every commit on vitest. Tests are co-located `*.test.ts` per repo convention.

**Organization**: Tasks are grouped by user story (spec.md). Story labels map to spec stories: US1 = signed-in dashboard link (P1), US2 = expired/used link fallback (P2, cloud-side), US3 = graceful degradation (P2), US4 = opt-out (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Include exact file paths in descriptions

## Path Conventions

Single-package CLI: all code under `src/` at repository root, co-located `*.test.ts` (see plan.md Project Structure).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization

No setup tasks. Existing single-package CLI; the plan introduces **zero new dependencies, zero new storage, zero toolchain changes** (plan.md Technical Context). Work starts directly on the existing branch `027-cli-web-session-handoff`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Wire shapes and shared types every story builds on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T001 [P] Add `handoffRequestSchema` (`{ redirect_to }` with relative-path refinement: starts with `/`, not `//`, no scheme) and `handoffResponseSchema` (`{ code, expires_at }`) with inferred types to src/cloud/schemas.ts, matching contracts/handoff-api.md
- [ ] T002 [P] Create src/cloud/handoff.ts skeleton: `HandoffSkipReason` union (`disabled-flag | disabled-default | unsupported | unavailable | rejected`), `HandoffResult` discriminated union, and pure `resolveHandoffPreference(flagValue: boolean | undefined, isTTY: boolean, mode: OutputMode)` implementing the precedence table from data-model.md (mirrors `resolveEffectiveLinkPrs` idiom in src/upload/upload-output.ts:81-88)

**Checkpoint**: Wire schemas + types compile; user story implementation can begin

---

## Phase 3: User Story 1 - Open dashboard without logging in again (Priority: P1) 🎯 MVP

**Goal**: After a successful upload, the printed dashboard link carries `?handoff=<code>` minted from `POST /api/auth/handoff`, so an interactive user lands on the dashboard signed in.

**Independent Test**: Unit/contract level — `requestHandoffUrl` against a stubbed `CloudClient` returns a decorated URL with existing query params preserved; command level — interactive upload run threads the decorated URL into text output and final-summary JSON. (Live redemption is verified end-to-end in Phase 4 once the cloud side exists.)

### Tests for User Story 1

> Write first; ensure they FAIL before implementing

- [ ] T003 [P] [US1] Contract tests in src/cloud/handoff.test.ts: zod round-trip of handoff request/response fixtures; `handoffRequestSchema` rejects absolute (`https://…`) and protocol-relative (`//…`) `redirect_to` values
- [ ] T004 [P] [US1] Unit tests in src/cloud/handoff.test.ts: `redirect_to` derivation = `pathname + search` of the dashboard URL (never host); decoration via `searchParams.set("handoff", code)` preserves existing query params; success path returns `{ active: true, dashboardUrl, expiresAt }`

### Implementation for User Story 1

- [ ] T005 [US1] Implement `requestHandoffUrl(client, dashboardUrl, preference)` in src/cloud/handoff.ts: skip with reason when preference inactive; otherwise `client.call({ method: "POST", path: "/api/auth/handoff", body, schema: handoffResponseSchema, timeoutMs: 3_000 })` and decorate the URL (research R-2/R-3/R-6)
- [ ] T006 [US1] Add `handoff` flag to src/commands/upload.ts (`Flags.boolean({ allowNo: true })`, **no default** so `undefined` is detectable, description covering `--handoff`/`--no-handoff`); resolve preference once via `resolveHandoffPreference(flags.handoff, process.stdout.isTTY, mode)`
- [ ] T007 [US1] Call `requestHandoffUrl` once in src/commands/upload.ts after the per-source pipeline loop (on `lastDashboardUrl`, src/commands/upload.ts:444); set `dashboardUrl` in `finalSummary` to the result's URL and add the optional `handoff` object per data-model.md presence rules (absent on default-off path); never mint on the dry-run (line ~321) or no-op (line ~355) paths
- [ ] T008 [US1] Relocate the human `Dashboard:` line from the pipeline completion event (src/upload/progress.ts:205) to command-level final text output in src/commands/upload.ts so the printed URL can carry the handoff code; add the dim expiry hint ("link signs you in — expires in ~60s") when active; keep all other completion output unchanged
- [ ] T009 [US1] Command-level tests in src/commands/upload.handoff.test.ts (conventions of src/commands/upload.degradation.test.ts): interactive default mints and decorates; final-summary JSON gains `handoff: { active: true, expiresAt }` only when active; dry-run/no-op never call the endpoint

**Checkpoint**: Interactive upload prints a decorated, expiry-hinted dashboard link; JSON contract additions verified

---

## Phase 4: User Story 2 - Expired or used link still gets you to the right place (Priority: P2) ⚠️ cross-repo

**Goal**: Stale/redeemed codes fall back to web login with the deep link preserved.

**Independent Test**: Against the local Docker stack: open a handoff link twice / after TTL → login wall, then land on the original dashboard page.

> Redemption, session creation, and deep-link preservation are **cloud/web obligations** (spec Assumptions; plan.md Cross-repo obligations). The CLI repo's tasks are coordination + the integration proof.

- [ ] T010 [US2] Open the cloud-side feature in `../frugl` (per its spec-kit workflow): reference specs/006-cli-web-session-handoff/contracts/handoff-api.md verbatim as the contract — `POST /api/auth/handoff` mint + grant invariants, redemption middleware (valid → Supabase cookie + 302 clean URL; invalid/expired/used → login with deep link; same-user serve; different-user explicit choice), audit events, Principle II authorization tests
- [ ] T011 [US2] Docker-stack integration test (location per 001 conventions, src/e2e/): full loop `login → upload --handoff → GET link (signed-in dashboard) → GET again (login wall) → login (lands on original deep link)`; covers spec US1 acceptance 2-4 and US2 acceptance 1-3 — **blocked on T010 landing in ../frugl**

**Checkpoint**: End-to-end redemption, single-use, expiry, and deep-link preservation proven against the local stack

---

## Phase 5: User Story 3 - Graceful degradation when handoff cannot be issued (Priority: P2)

**Goal**: Any issuance failure leaves the upload's outcome untouched: plain URL, unchanged exit code, one honest informational note.

**Independent Test**: Stub every failure class against `requestHandoffUrl`; assert each returns `{ active: false, reason }` (never throws) and the upload command's exit code and `ok: true` summary are unchanged.

### Tests for User Story 3

> Write first; ensure they FAIL before implementing

- [ ] T012 [P] [US3] Unit tests in src/cloud/handoff.test.ts: failure taxonomy per contracts/handoff-api.md status table — 404/405 → `unsupported`; 400/401/403 → `rejected`; timeout/network/429/5xx/426/zod-parse → `unavailable`; no error escapes; 3s timeout honored (fake timers)

### Implementation for User Story 3

- [ ] T013 [US3] Implement total-function degradation in src/cloud/handoff.ts: catch `CloudHttpError`/`NetworkError`/`ZodError`/timeout from `client.call`, map status → `HandoffSkipReason`, always return `{ active: false, dashboardUrl: <plain>, reason }` (research R-7)
- [ ] T014 [US3] Surface degradation honestly in src/commands/upload.ts text output: plain `Dashboard:` line plus one dim note ("sign-in link unavailable — log in on the web") when reason is `unsupported | unavailable | rejected`; JSON carries `handoff: { active: false, reason }`; exit code and `ok` status provably unchanged (Principle VI + spec FR-008)
- [ ] T015 [US3] Command-level test in src/commands/upload.handoff.test.ts: upload with failing handoff endpoint exits 0 with `ok: true`, plain `dashboardUrl`, `handoff.reason` populated, and no retry delay beyond the 3s bound

**Checkpoint**: No failure mode of the convenience call can harm or noticeably delay a successful upload

---

## Phase 6: User Story 4 - Opt out on shared terminals and CI (Priority: P3)

**Goal**: `--no-handoff` and the non-interactive default keep credential material out of printed output entirely.

**Independent Test**: Truth-table the preference resolution; verify the opted-out/default-off paths make **no wire request** and emit byte-identical-to-today JSON.

### Tests for User Story 4

> Write first; ensure they FAIL before implementing

- [ ] T016 [P] [US4] Unit tests in src/cloud/handoff.test.ts: full precedence truth table from data-model.md — `--no-handoff` wins everything; `--handoff` forces on in JSON/non-TTY; unset → on only when TTY ∧ text mode

### Implementation for User Story 4

- [ ] T017 [US4] Enforce no-issuance paths in src/cloud/handoff.ts + src/commands/upload.ts: inactive preference short-circuits before any `client.call`; JSON summary shows `handoff: { active: false, reason: "disabled-flag" }` for the explicit flag and **omits the key entirely** on the default-off path (byte-identical for existing `--json` consumers, research R-8)
- [ ] T018 [US4] Command-level tests in src/commands/upload.handoff.test.ts: `--no-handoff` → zero handoff wire calls; `--json` without flag → no `handoff` key, plain `dashboardUrl`; `--json --handoff` → decorated; non-TTY stdout → default off

**Checkpoint**: All four stories independently verified

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, contract bookkeeping, full-gate validation

- [ ] T019 [P] Document `--handoff` / `--no-handoff` and the sign-in-link behavior in README.md (flag table + a one-line privacy note: single-use, ~60s, off by default in CI)
- [ ] T020 [P] Record the additive output-contract change (optional `handoff` object, decorated `dashboardUrl`) in specs/001-cli-ingest-client/contracts/command-output.schema.json per its additive-evolution rule, cross-referencing specs/006-cli-web-session-handoff/data-model.md
- [ ] T021 Run quickstart.md verification end-to-end against the local Docker stack (happy path, single-use, expiry, degradation, opt-out surface) — final gate alongside T011
- [ ] T022 Full pre-commit gate green: `pnpm` `format` (oxfmt), `lint` (oxlint), `typecheck` (tsc), `test` (vitest) — constitution Principle V

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: No prerequisites — BLOCKS all stories
- **US1 (Phase 3)**: Depends on T001 + T002
- **US2 (Phase 4)**: T010 has no CLI-side dependency (can start immediately after spec exists); T011 depends on US1 (needs `--handoff` working) **and** T010 (cloud side deployed to the local stack)
- **US3 (Phase 5)**: Depends on T005 (the function being hardened); independent of US2/US4
- **US4 (Phase 6)**: Depends on T002 + T006 (preference + flag exist); independent of US2/US3
- **Polish (Phase 7)**: T019/T020 after US1; T021 after T011; T022 last

### User Story Dependencies

- **US1 (P1)**: Foundational only — the MVP
- **US2 (P2)**: Cross-repo; CLI-side proof (T011) is the only task gated on external work
- **US3 (P2)**: Builds on US1's function; testable without any cloud
- **US4 (P3)**: Builds on US1's flag; testable without any cloud

### Within Each User Story

- Tests written first and failing before implementation
- `src/cloud/handoff.ts` changes before `src/commands/upload.ts` wiring

### Parallel Opportunities

- T001 ∥ T002 (different files)
- T003 ∥ T004 (same file but pure test-authoring; safe for one dev, sequential for agents)
- After US1: US3 and US4 can proceed in parallel with each other and with T010/T019/T020
- T010 (cloud repo) can run in parallel with **all** CLI-side phases from day one

---

## Parallel Example: post-US1 fan-out

```bash
# Once Phase 3 (US1) is checkpointed, these can run concurrently:
Task: "US3 degradation hardening in src/cloud/handoff.ts (T012-T015)"
Task: "US4 opt-out surface tests/wiring (T016-T018)"
Task: "Cloud-side feature in ../frugl from contracts/handoff-api.md (T010)"
Task: "README flag docs (T019)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 2 (T001-T002) → Phase 3 (T003-T009)
2. **STOP and VALIDATE**: decorated link + JSON additions, against a stubbed cloud
3. Ship — against a cloud without the endpoint, the unimplemented degradation path is still safe *enough* only after US3; in practice US1+US3 is the honest minimum ship unit since real clouds may predate the endpoint

### Incremental Delivery

1. US1 → decorated links work where the cloud supports them (MVP)
2. US3 → bulletproof against clouds that don't (ship gate for npm release)
3. US4 → CI/shared-terminal hygiene
4. US2 (T011) → end-to-end proof once `../frugl` lands the endpoint; then T021/T022 close it out

### Cross-repo coordination

T010 is the long pole — kick it off first. Everything CLI-side except T011/T021 completes without it.

---

## Notes

- Total: **22 tasks** (20 CLI-repo, 1 cross-repo kickoff, 1 cross-repo-gated integration proof)
- Counts per story: US1 = 7 (T003-T009), US2 = 2 (T010-T011), US3 = 4 (T012-T015), US4 = 3 (T016-T018), Foundational = 2, Polish = 4
- No new dependencies, no new persistence, `UploadCloudPort` untouched (research R-6/R-9)
- Commit after each task or logical group (auto-commit hooks are enabled for speckit phases)

# Tasks: poppi-cli org membership — `poppi join` + org-aware `whoami` / `upload`

**Input**: Design documents from `/specs/004-cli-org-join/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Foundation**: This feature builds on the COMPLETED `001-cli-ingest-client` (oclif scaffold, `src/cloud/client.ts`, `src/cloud/schemas.ts`, `src/cloud/version-gate.ts`, `src/cloud/endpoints.ts`, `src/lib/exit-codes.ts`, `src/lib/errors.ts`, `src/lib/output-mode.ts`, `src/lib/retry.ts`, `src/auth/keychain.ts`, `src/commands/{whoami,upload}.ts`, `src/upload/summary.ts`). Those `001` modules MUST exist before this feature's tasks run — that is the single blocking external dependency (see Dependencies). This feature adds **no new runtime dependencies** (plan.md Technical Context).

**Organization**: Tasks are grouped by user story so each story can be implemented and tested independently. Test-first tasks are included where `001`'s tasks.md did so (contract tests for cloud responses; unit tests for pure logic and the exit-code-bearing paths). Per the spec's SC list, the no-leak (SC-005), typed-error fidelity (SC-003), idempotency (SC-004), and gate-honesty (SC-008) behaviours are release-relevant and get explicit test tasks.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to ([US1]–[US6])
- Each description includes the exact target file path

---

## Phase 1: Setup (Verify foundation)

**Purpose**: Confirm the `001` foundation this feature edits is present before any work begins. No code is written here; this phase fails fast if `001` has not landed.

- [ ] T001 Verify the `001-cli-ingest-client` migration has landed: `src/cloud/{client,schemas,version-gate,endpoints}.ts`, `src/lib/{exit-codes,errors,output-mode,retry}.ts`, `src/auth/keychain.ts`, `src/commands/{whoami,upload}.ts`, and `src/upload/summary.ts` all exist and `pnpm typecheck && pnpm test` pass on `main`. If absent, STOP — `004` cannot proceed (plan.md "Note on the current scaffold state").

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Cross-cutting additions that every user story depends on — the four new exit codes, the typed error classes, the new cloud zod schemas, and the two transport wrappers. No user-story command work can begin until these exist.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T002 [P] Add the four new exit codes to the frozen `EXIT` table — `ORG_REQUIRED: 12`, `JOIN_CODE_REJECTED: 70`, `ALREADY_IN_OTHER_ORG: 71`, `RATE_LIMITED: 72` — without reassigning any existing `001` code (these and the reused `001` codes are public contract and MUST NOT shift between releases without a coordinated cross-repo bump, FR-033), per data-model.md §7 / R-9 / FR-032/FR-033 in `src/lib/exit-codes.ts`
- [ ] T003 [P] Add typed error classes `OrgRequiredError` (12), `JoinRejectedError` (70, carries sub-`reason`), `WrongOrgError` (71, carries `currentOrgName`/`targetOrgName`), `RateLimitedError` (72, carries `retryAfterSeconds`), each carrying its `EXIT` code in the `001` errors pattern, per data-model.md "Typed error classes" / R-4 in `src/lib/errors.ts`
- [ ] T004 [P] Add zod schemas to `src/cloud/schemas.ts`: `JoinSuccessSchema` (`{ org:{id,name,slug}, membership:{id,role,joined_at} }`), `JoinErrorSchema` (`{ error, message, details? }` with the typed `error` enum), `OrgContextSchema` (`200` `{ org:{id,name,slug,member_count,created_at}, membership:{role,joined_at} }`), and `OrgRequiredSchema` (`{ error:"org_required" }`); export derived TS types; role enum = `owner|admin|member`, per contracts/join.md + contracts/orgs-me.md / FR-012 in `src/cloud/schemas.ts`
- [ ] T005 Create `redeemCode(endpoint, token, normalizedCode)` calling `POST /api/join` with `Content-Type: application/json`, body exactly `{"code":"<normalized>"}` (NO `org_id`, NO `redaction_policy_version` — join processes no session data, FR-023), via the existing `src/cloud/client.ts` (CLI-version header per FR-011 + version-gate intercept + auth bearer come for free); zod-parse the response (T004); map each documented status/`error` to a `JoinOutcome` discriminated union OR a thrown typed error per the R-4 mapping (incl. `409 already_member` → `kind:"already-member"`, NOT an error); reuse `src/lib/retry.ts` so only transient `5xx`/network is retried and `429`/4xx/`401`/`426` fail fast (R-6/FR-013); never log the plaintext code (R-11) per FR-011/FR-023 in `src/cloud/join.ts`
- [ ] T006 Create `getOrgContext(endpoint, token)` calling `GET /api/orgs/me` via `src/cloud/client.ts`; zod-parse (T004); return `OrgContext` discriminated union `{kind:"member",org,membership}` on `200` or `{kind:"none"}` on `409 org_required` (modelled as DATA, not thrown — R-3); throw `AuthError` on `401`; bounded retry on transient only, per contracts/orgs-me.md / FR-024/027 in `src/cloud/orgs.ts`

**Checkpoint**: Exit codes, errors, schemas, and both transport wrappers exist. All user-story phases can now begin.

---

## Phase 3: User Story 1 — Redeem an invite code and join (Priority: P1) 🎯 MVP

**Goal**: Implement `poppi join <code>` end-to-end: normalize + locally validate the code, redeem it, render the success message (and the idempotent already-member success), with `--json` output.

**Independent Test**: With the local stack running and an admin-generated code, a second logged-in account runs `poppi join <code>`; exit 0; a `memberships` row appears at the code's role and `invitations.used_count` increments by 1 (spec US1 Independent Test). Re-running exits 0 with "already a member" (SC-004).

### Tests for User Story 1 (write first, ensure they FAIL before implementation) ⚠️

- [ ] T007 [P] [US1] Write `src/join/normalize.test.ts`: assert uppercase + whitespace/separator/non-Crockford stripping maps `"acme xklm7p3r"`, `"ACME-XKLM-7P3R"`, and `"acmexklm7p3r"` to the same normalized value; assert idempotence of `normalize(normalize(x))` per FR-004 / R-10 in `src/join/normalize.test.ts`
- [ ] T008 [P] [US1] Write `src/join/validate.test.ts`: assert base32-Crockford alphabet (`0-9A-Z` minus `I L O U`) acceptance; reject out-of-alphabet and out-of-length codes; assert validation runs with NO network (pure function) per FR-005 in `src/join/validate.test.ts`
- [ ] T009 [P] [US1] Write `src/cloud/join.test.ts` (contract): zod round-trip the `200` success body and the `409 already_member` body; assert `redeemCode` returns `kind:"joined"` (with role verbatim) and `kind:"already-member"` respectively; assert a malformed `200` body throws the ZodError→`GENERIC_FAILURE` path per FR-012 / R-2 / SC-006 in `src/cloud/join.test.ts`

### Implementation for User Story 1

- [ ] T010 [P] [US1] Create `normalize(raw)`: uppercase, strip whitespace + separators + characters outside base32-Crockford; return the normalized string (the value sent on the wire), per FR-004 / R-10 in `src/join/normalize.ts`
- [ ] T011 [P] [US1] Create `validate(normalized)`: enforce base32-Crockford alphabet + documented length bounds; throw a `USAGE`-coded error with "wrong length" / "unexpected characters" messages on failure, per FR-005 / spec edge cases in `src/join/validate.ts`
- [ ] T012 [US1] Create `src/commands/join.ts` as a top-level oclif Command (`poppi join <code>`, NOT under a `poppi org` namespace, FR-001): required single positional `<code>` (strict args → `USAGE` on missing/extra); honour `--endpoint`/`POPPI_ENDPOINT` (FR-002) and `--json` (FR-021) / `--no-color` / `NO_COLOR` (no escape codes into a non-TTY, FR-022); pipeline = read token from keychain (no token → `AUTH_FAILURE` before network FR-008; keychain unavailable → `KEYCHAIN_UNAVAILABLE` FR-009) → normalize (T010) → validate (T011) → `redeemCode` (T005); on `kind:"joined"` print "✓ Joined `<name>` (`<slug>`) as `<role>`." + next-step line on stdout with the role verbatim, exit 0 (FR-019); on `kind:"already-member"` print "You are already a member of `<Org>`." exit 0 (FR-017/R-2); register the command in `src/index.ts` so `poppi --help`/`poppi join --help` discover it (FR-001/FR-003) per FR-001/FR-002/FR-022 in `src/commands/join.ts`
- [ ] T013 [US1] Add help text to `src/commands/join.ts`: name the `<code>` argument, show one example (`poppi join ACME-XKLM-7P3R`), and state the code is obtained from an Org Admin; warn that `--debug` output may contain the code (secret) per FR-003 / FR-006 in `src/commands/join.ts`

**Checkpoint**: `poppi join <code>` joins on the happy path and is idempotent on re-join; `poppi --help` lists it.

---

## Phase 4: User Story 2 — Auth / keychain failure paths (Priority: P1)

**Goal**: Ensure `poppi join` fails cleanly and early when there is no token, the token is rejected, or the keychain is unavailable — with zero network requests in the no-token case.

**Independent Test**: On a clean machine with no token, `poppi join ANY-VALID-FORMAT` exits `AUTH_FAILURE`, prints the "not signed in" message on stderr, and makes zero network requests (mock-server assertion, SC-002).

### Tests for User Story 2 ⚠️

- [ ] T014 [P] [US2] Write `src/commands/join.auth.test.ts`: with a recording mock client, assert no-token → `AUTH_FAILURE` (10) and ZERO network calls (SC-002); `401` from `/api/join` → `AUTH_FAILURE` (10) with "session has expired" and no retry/no re-prompt (FR-010); keychain-unavailable → `KEYCHAIN_UNAVAILABLE` (11) per FR-008/009/010 in `src/commands/join.auth.test.ts`

### Implementation for User Story 2

- [ ] T015 [US2] In `src/commands/join.ts`, wire the auth gate ahead of any network request: read token via `src/auth/keychain.ts`; missing → throw `AuthError` (10) with "You're not signed in. Run `poppi login` first…"; keychain error → `KeychainError` (11) with the same class `upload` uses; ensure the `401` thrown by `redeemCode`/client surfaces as `AUTH_FAILURE` with "Your session has expired…" and is never retried or re-prompted (FR-010) per FR-007/008/009/010 in `src/commands/join.ts`

**Checkpoint**: No-auth and keychain failures fast-fail with the documented codes; zero network in the no-token case.

---

## Phase 5: User Story 3 — Typed redemption errors render actionably (Priority: P1)

**Goal**: Each typed `/api/join` error renders the documented user-facing message and exits with the documented code; transient `5xx` retries then `NETWORK_FAILURE`; `426` version-gate; contract drift → `GENERIC_FAILURE`.

**Independent Test**: For each typed error response (canned), the CLI prints the documented string, exits with the documented code, and makes no further network requests; `wrong_org` interpolates `current_org_name`/`target_org_name` verbatim (spec US3 Independent Test / SC-003).

### Tests for User Story 3 ⚠️

- [ ] T016 [P] [US3] Write `src/cloud/join.errors.test.ts` (contract): one canned-response case per typed error — `not_found`/`expired`/`revoked`/`exhausted` → `JoinRejectedError` (70) with sub-reason; `wrong_org` → `WrongOrgError` (71) carrying both org names from `details`; `rate_limited` → `RateLimitedError` (72) reading `Retry-After` header (fallback `details.retry_after_seconds`), NOT retried; `426` → `VersionGateError` (50); `400 validation_failed` → `USAGE` (2); malformed error body → `GENERIC_FAILURE` (1); per FR-014/016/018 / R-4/R-5 / SC-003/SC-006 in `src/cloud/join.errors.test.ts`
- [ ] T017 [P] [US3] Write `src/commands/join.render.test.ts`: assert each typed outcome renders the exact documented user-facing message (table in contracts/join.md) on STDERR with stdout empty (FR-020); assert `wrong_org` interpolates `details.current_org_name`/`details.target_org_name`; assert `5xx`-exhaustion message + `NETWORK_FAILURE` (40) per FR-016/018/020 / US3 scenario 3 in `src/commands/join.render.test.ts`

### Implementation for User Story 3

- [ ] T018 [US3] Complete the error mapping in `src/cloud/join.ts` (T005): translate `404/410` → `JoinRejectedError` with the sub-reason; `409 wrong_org` → `WrongOrgError` carrying `details.current_org_name`/`details.target_org_name` verbatim (FR-018, never client-guessed, R-5); `429` → `RateLimitedError` with `Retry-After`/`details.retry_after_seconds`; `400 validation_failed` → a `USAGE`-coded error surfacing the server's `message`; `426` → `VersionGateError` (shared); `5xx` exhaustion → `NetworkError` per FR-013/FR-014/FR-015/FR-016/FR-018 in `src/cloud/join.ts`
- [ ] T019 [US3] In `src/commands/join.ts`, render each thrown typed error to its documented message on stderr (stdout empty, FR-020), exiting with the carried code; render the shared version-gate message on `VersionGateError` (FR-015) and the "couldn't reach the server" message on `NetworkError` per FR-016/018/020 in `src/commands/join.ts`

**Checkpoint**: All typed `/api/join` errors render the documented message + exit code; transient handling and version-gate behave as `001`.

---

## Phase 6: User Story 4 — `poppi whoami` reports org + role (Priority: P1)

**Goal**: `poppi whoami` calls `GET /api/orgs/me` and reports the org + role (member) or the no-org state with both remedies (exit 0 either way); `--json` adds the additive `organization` field.

**Independent Test**: A member account's `whoami` names the org + role matching `GET /api/orgs/me`, exit 0; a no-Membership account reports "no org yet" with remedies, exit 0; logged-out exits `AUTH_FAILURE` (spec US4 Independent Test / SC-007).

### Tests for User Story 4 ⚠️

- [ ] T020 [P] [US4] Write `src/commands/whoami.org.test.ts`: member → output names org (name+slug+member_count) and role, exit 0; `409 org_required` → "Not a member of any organization yet." + both remedies, exit 0 (NOT `ORG_REQUIRED`); logged-out → unchanged `AUTH_FAILURE` (10); `--json` → `organization` is the org object on member and `null` on no-Membership (FR-026) per FR-024/025/026 / SC-007 in `src/commands/whoami.org.test.ts`

### Implementation for User Story 4

- [ ] T021 [US4] Edit `src/commands/whoami.ts`: after the existing `001` identity report, call `getOrgContext` (T006); on `kind:"member"` print "Organization: `<name>` (`<slug>`) — `<member_count>` members" + "Your role: `<role>`"; on `kind:"none"` print "Not a member of any organization yet." + `poppi join <code>` and dashboard remedies; exit 0 in BOTH cases (FR-025); honour `--endpoint`/`POPPI_ENDPOINT` per FR-024/025 in `src/commands/whoami.ts`
- [ ] T022 [US4] Extend the `whoami` `--json` result in `src/commands/whoami.ts`: add the additive `organization` field — the org object (`id,name,slug,member_count,role`) on member, `null` on no-Membership — to the `001` `WhoamiResultOk`, matching contracts/command-output.schema.json `WhoamiResultOkWithOrg`; no existing field renamed/removed (FR-026 / R-12) in `src/commands/whoami.ts`

**Checkpoint**: `whoami` reports org context in text and `--json`; no-org is an exit-0 reported state.

---

## Phase 7: User Story 5 — `poppi upload` onboarding gate (Priority: P1)

**Goal**: `poppi upload` resolves org context BEFORE discovery/anonymization; a no-Membership user hits the `ORG_REQUIRED` gate with zero work done (incl. under `--dry-run`); a mid-upload `401`/`403` exits `AUTH_FAILURE` preserving resume state.

**Independent Test**: A logged-in no-Membership account runs `poppi upload`: no presign/manifest call, no anonymization, zero bytes, the onboarding-gate message naming both remedies, exit `ORG_REQUIRED`; a mock-server run asserts no upload endpoint was hit (spec US5 Independent Test / SC-008).

### Tests for User Story 5 ⚠️

- [ ] T023 [P] [US5] Write `src/commands/upload.org-gate.test.ts`: with a recording mock client, `409 org_required` from `GET /api/orgs/me` → `ORG_REQUIRED` (12), gate message naming both remedies, ZERO upload-endpoint hits, zero bytes, no inspection dir; same under `--dry-run` (FR-028); `GET /api/orgs/me` transient-exhaustion → `NETWORK_FAILURE` (40) BEFORE any anonymize/transmit; mid-upload `401`/`403` → `AUTH_FAILURE` (10) with resume state preserved (FR-031) per FR-027/028/031 / SC-008 in `src/commands/upload.org-gate.test.ts`

### Implementation for User Story 5

- [ ] T024 [US5] Edit `src/commands/upload.ts`: insert `getOrgContext` (T006) immediately after endpoint resolution + auth-token load and BEFORE discovery/classify/anonymize (R-7); on `kind:"none"` throw `OrgRequiredError` (12) and print the onboarding-gate message ("You haven't joined an organization yet…" + both remedies + "No sessions were discovered, anonymized, or transmitted."), doing zero discovery/anonymization/transmission and writing no inspection dir; this gate MUST fire under `--dry-run` too (FR-028); on `GET /api/orgs/me` transient-exhaustion exit `NETWORK_FAILURE` before proceeding per FR-027/028 in `src/commands/upload.ts`
- [ ] T025 [US5] In `src/commands/upload.ts`, ensure a `401`/`403` from any cloud call AFTER org resolution but before batch completion exits `AUTH_FAILURE` (10), preserves the `001` resume state (FR-026/029c), and instructs the user to verify access and re-run — no partial-success downgrade (FR-031 / R-8) in `src/commands/upload.ts`

**Checkpoint**: The no-org gate fires before any local work (incl. `--dry-run`); mid-upload auth loss preserves resume state.

---

## Phase 8: User Story 6 — `poppi upload` names the destination org (Priority: P2)

**Goal**: For a member, the pre-upload summary names the destination org + role (in addition to the `001` FR-020 fields); under `--confirm`/`--yes` the destination is still emitted; the `--json` `upload-start` event carries an additive `organization` object.

**Independent Test**: A member runs `poppi upload` without `--confirm`; the summary contains a line naming the org (name+slug) and role from the same `GET /api/orgs/me` call; under `--json` the `upload-start` event carries org id+slug (spec US6 Independent Test / SC-009).

### Tests for User Story 6 ⚠️

- [ ] T026 [P] [US6] Write/extend `src/upload/summary.test.ts`: assert the rendered summary includes "Uploading to: `<name>` (`<slug>`) — your role: `<role>`" alongside the existing FR-020 counts/policy line; snapshot the new line (FR-029 / SC-009) in `src/upload/summary.test.ts`
- [ ] T027 [P] [US6] Write `src/commands/upload.org-event.test.ts`: assert that with `--confirm` the destination is emitted on stderr (text) and that the `--json` `upload-start` event carries an additive `organization:{id,slug}` with all `001` fields intact (strictly additive) per FR-029/030 / R-12 / SC-009 in `src/commands/upload.org-event.test.ts`

### Implementation for User Story 6

- [ ] T028 [US6] Edit `src/upload/summary.ts`: accept the resolved `{ org, role }` (from T024's `getOrgContext`) and prepend a "Uploading to: `<name>` (`<slug>`) — your role: `<role>`" line to the pre-upload summary; do not re-fetch `GET /api/orgs/me` (reuse the single resolution) per FR-029 in `src/upload/summary.ts`
- [ ] T029 [US6] In `src/commands/upload.ts`, thread the resolved org into the summary (T028) and into the `upload-start` NDJSON event as an additive `organization:{id,slug}` (FR-030); under `--confirm`/`--yes` emit the destination on stderr (text) or via the event (`--json`) so non-interactive runs record where the batch went (FR-029) per FR-029/030 / R-12 in `src/commands/upload.ts`

**Checkpoint**: The destination org is named in the summary and the `upload-start` event; non-interactive runs still record it.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: The no-leak invariant, the help/docs surface, the `--json` schema validation, and the end-to-end SC loop.

- [ ] T030 [P] Write `src/commands/join.noleak.test.ts`: run `poppi join <code>` at the default log level and assert the captured stdout+stderr does NOT contain the plaintext code (the success message names the ORG, not the code); assert the `--json` result object contains no `code` field per SC-005 / FR-006 in `src/commands/join.noleak.test.ts`
- [ ] T031 [P] Write `src/cloud/orgs.test.ts` (contract): zod round-trip the `200` member body and the `409 org_required` body; assert `getOrgContext` returns `kind:"member"` (role verbatim, member_count present) and `kind:"none"` respectively; `401` throws `AuthError`; malformed body → `GENERIC_FAILURE` per FR-012 / R-3 / SC-006 in `src/cloud/orgs.test.ts`
- [ ] T032 [P] Add a `--json` schema-validation test asserting the `JoinResultOk`/`JoinResultError`/`WhoamiResultOkWithOrg` shapes and the `upload-start` `organization` extension validate against `specs/004-cli-org-join/contracts/command-output.schema.json` (same zod/JSON-schema approach `001` uses for its output contracts) per FR-021/026/030 / FR-036 in `src/cloud/output-contract.test.ts`
- [ ] T033 [P] Update README.md / docs: document `poppi join <code>` (one example, code from Org Admin, `--debug`-may-leak warning), the org lines in `whoami`, the `ORG_REQUIRED` gate and destination line in `upload`, and link to `specs/004-cli-org-join/quickstart.md`; list the four new exit codes per FR-003/006 / contracts/exit-codes.md in `README.md`
- [ ] T034 Run the end-to-end SC loop against the local stack per quickstart.md §11: admin generates a code → `poppi login` → `poppi join <code>` (exit 0, < 30 s, SC-001) → re-join (exit 0, SC-004) → `poppi whoami` names org+role (SC-007) → a no-Membership account's `poppi upload`/`--dry-run` hits `ORG_REQUIRED` with zero bytes/no upload-endpoint hit (SC-008) → a member's `poppi upload` names the destination (SC-009); confirm every exit code matches `contracts/exit-codes.md`; assert the no-leak invariant on real output (SC-005)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Verifies the `001` foundation — the single external blocking dependency. Must pass before anything else.
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user-story phases (exit codes, errors, schemas, transport wrappers).
- **US1 (Phase 3)**: Depends on Phase 2. The MVP — `poppi join` happy path + idempotent re-join.
- **US2 (Phase 4)**: Depends on Phase 2; extends `src/commands/join.ts` from US1 (auth gate). Best done right after US1 since both edit `join.ts`.
- **US3 (Phase 5)**: Depends on Phase 2; completes the error mapping in `src/cloud/join.ts` (T005→T018) and `join.ts` rendering. Best done after US1.
- **US4 (Phase 6)**: Depends on Phase 2 only (edits `whoami.ts`). Independent of US1–US3 — can run in parallel with the join phases.
- **US5 (Phase 7)**: Depends on Phase 2 only (edits `upload.ts`). Independent of the join phases.
- **US6 (Phase 8)**: Depends on US5 (reuses the `getOrgContext` resolution T024 wires into `upload.ts`) and edits `src/upload/summary.ts`.
- **Polish (Phase 9)**: Depends on all story phases.

### User Story Dependencies

- **US1 (P1)**: After Foundational. No dependency on other stories.
- **US2 (P1)**: After Foundational; shares `join.ts` with US1 (sequence US1 → US2 to avoid same-file churn).
- **US3 (P1)**: After Foundational; shares `cloud/join.ts` + `join.ts` with US1 (sequence after US1).
- **US4 (P1)**: After Foundational. Fully independent (only `whoami.ts`) — parallelizable with US1–US3 and US5.
- **US5 (P1)**: After Foundational. Independent of the join stories (only `upload.ts`).
- **US6 (P2)**: After US5 (consumes US5's org resolution in `upload.ts`).

### Within Each Phase

- `[P]` tasks touch different files and have no intra-phase dependency — safe to run concurrently.
- Test tasks are written FIRST and must FAIL before their implementation tasks (TDD, matching `001`).
- Within `src/cloud/join.ts`: T005 (skeleton + success/already-member) precedes T018 (full error mapping).
- Within `src/commands/join.ts`: T012 (happy path) → T015 (auth gate) → T019 (error rendering); all edit the same file, so they sequence.

### Parallel Opportunities

```bash
# Phase 2: all [P] foundational tasks run simultaneously
# T002 exit-codes | T003 errors | T004 schemas   (T005 redeemCode, T006 getOrgContext after T004)

# After Phase 2, the independent stories fan out across files:
#   Track A (join):   US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5)   [src/join/, src/cloud/join.ts, src/commands/join.ts]
#   Track B (whoami): US4 (Phase 6)                                    [src/commands/whoami.ts]
#   Track C (upload): US5 (Phase 7) → US6 (Phase 8)                    [src/commands/upload.ts, src/upload/summary.ts]
# Tracks A, B, C edit disjoint files and can be developed in parallel by three developers.

# Phase 3 tests run simultaneously: T007 normalize | T008 validate | T009 cloud/join contract
# Phase 9 tests run simultaneously: T030 noleak | T031 orgs contract | T032 output-contract | T033 docs
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 (verify `001`) → Phase 2 (Foundational) → Phase 3 (US1).
2. **STOP and VALIDATE**: `poppi join <code>` against the local stack joins (exit 0) and re-joins idempotently (exit 0).
3. This is the minimum shippable increment of the feature.

### Incremental Delivery

1. Phases 1–3 → `poppi join` happy path (MVP).
2. - Phases 4–5 → full `join` robustness (auth + typed errors). The `join` command is now complete and trustworthy (SC-002/003/004/005).
3. - Phase 6 (US4) → `whoami` org awareness (SC-007).
4. - Phase 7 (US5) → `upload` onboarding gate (SC-008).
5. - Phase 8 (US6) → `upload` destination naming (SC-009).
6. Phase 9 → no-leak/output-contract tests, docs, and the end-to-end SC loop.

### Parallel Team Strategy

After Phase 2, three developers can take the disjoint tracks: A (join: US1→US2→US3), B (whoami: US4), C (upload: US5→US6). They reconvene for Phase 9.

---

## Notes

- `[P]` tasks = different files, no intra-phase dependencies; safe to run concurrently.
- `[Story]` label maps each task to its user story for traceability against spec.md.
- This feature adds NO new runtime dependencies (plan.md) and NO new persistent local state (data-model.md) — there are deliberately no setup/migration tasks beyond verifying `001`.
- Tests are included for the contract surface (cloud responses), the pure logic (normalize/validate), and the release-relevant invariants (no-leak SC-005, typed-error fidelity SC-003, idempotency SC-004, gate honesty SC-008), matching where `001`'s tasks.md included tests.
- All exit codes must match `contracts/exit-codes.md` + `specs/001-cli-ingest-client/contracts/exit-codes.md` exactly; scripts and the MCP wrapper depend on stability (FR-032/033).
- The pre-commit gate (format + lint + typecheck + test) must pass before every commit; `--no-verify` is forbidden by constitution Principle V.

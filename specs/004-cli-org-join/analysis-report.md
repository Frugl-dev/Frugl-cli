# Cross-Artifact Analysis Report: `004-cli-org-join`

**Feature**: 004-cli-org-join | **Date**: 2026-05-24 | **Phase**: post-`/speckit-tasks` (non-destructive consistency analysis)

**Scope**: Consistency across `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, and `tasks.md`; alignment with the Poppi Cloud Constitution v2.0.0; and fidelity of the cloud-contract references to the actual cloud `003-org-membership-permissions` contracts (`poppi/specs/003-org-membership-permissions/contracts/{join,orgs,README}.md`).

**Method**: Built a requirement -> task traceability matrix for all 33 FRs and 6 user stories; reverse-checked every task to a requirement; checked the 9 SCs for test coverage; diffed the consumer-contract field names against the authoritative cloud contracts; re-ran the Constitution Check.

**Verdict**: No blocking inconsistencies. All 33 FRs and all 6 user stories trace to >=1 task; every task traces to a requirement; the exit-code additions are internally consistent across `data-model.md`, `contracts/exit-codes.md`, `research.md` R-9, and `tasks.md`; cloud-contract field names match `003`. Three minor items were found; two were resolved in-artifact (see below) and one is a documented, justified consumer inference (no change needed). No new scope was introduced.

---

## 1. Requirement -> Task traceability (FR coverage)

Every functional requirement maps to at least one task. Summary matrix:

| FR group               | FRs            | Covering tasks                                   |
| ---------------------- | -------------- | ------------------------------------------------ |
| `join` command surface | FR-001..003    | T012 (positional/registration), T013 (help)      |
| `join` input handling  | FR-004..006    | T007/T010 (normalize), T008/T011 (validate), T030 (no-leak SC-005) |
| Shared auth            | FR-007..010    | T014/T015 (auth+keychain gate)                   |
| `join` network         | FR-011..018    | T005/T018 (redeem+mapping), T009/T016 (contract tests), T017/T019 (render) |
| `join` output          | FR-019..023    | T012 (success/idempotent), T019 (errors on stderr), T032 (`--json`), T013 (color/help); FR-023 anchored to T005 (no `redaction_policy_version` in body) + T009 |
| `whoami` org awareness | FR-024..026    | T020 (test), T021 (report), T022 (`--json`)      |
| `upload` org awareness | FR-027..031    | T023 (test), T024 (gate), T025 (mid-upload auth), T028/T029 (destination), T026/T027 (tests) |
| Exit codes             | FR-032..033    | T002 (table), T003 (errors), T032/T034 (verification) |

**User stories**: US1 -> Phase 3 (T007-T013); US2 -> Phase 4 (T014-T015); US3 -> Phase 5 (T016-T019); US4 -> Phase 6 (T020-T022); US5 -> Phase 7 (T023-T025); US6 -> Phase 8 (T026-T029). All six covered.

**Success criteria -> test tasks**: SC-001 (T034), SC-002 (T014), SC-003 (T016/T017), SC-004 (T009/T034), SC-005 (T030), SC-006 (T009/T016/T031), SC-007 (T020), SC-008 (T023), SC-009 (T026/T027). All nine have at least one verifying task.

**Reverse check**: every task T002-T034 cites at least one FR / SC / research item. No orphan tasks. No task introduces behaviour absent from the spec (the only non-spec task, T001, is a foundation-verification gate, explicitly justified by plan.md's scaffold-state note).

---

## 2. Internal consistency checks

- **Exit-code values agree across artifacts.** `ORG_REQUIRED=12`, `JOIN_CODE_REJECTED=70`, `ALREADY_IN_OTHER_ORG=71`, `RATE_LIMITED=72` are identical in spec FR-032, `data-model.md` section 7, `research.md` R-9, `contracts/exit-codes.md`, and `tasks.md` T002. No collision with the `001` table (which ends at `INSPECT_DIR_EXISTS=60`); all four sit in `001`-reserved gaps. PASS
- **`already_member` -> exit 0 is consistent everywhere.** spec FR-017/US1-4, `research.md` R-2, `data-model.md` section 2, `contracts/join.md` mapping table, and tasks T012/T009. No artifact treats it as a failure. PASS
- **`org_required` dual interpretation is consistent.** Reported state (exit 0) for `whoami`, hard gate (exit 12) for `upload` -- agrees across spec edge cases, `research.md` R-3, `contracts/orgs-me.md` per-command table, and tasks T021/T024. PASS
- **`--json` additive claims agree.** `whoami.organization` (obj|null) and `upload-start.organization` ({id,slug}) are described identically in `data-model.md` sections 5/6, `contracts/command-output.schema.json`, `research.md` R-12, and tasks T022/T029/T032. The schema's `additionalProperties:false` on the new shapes governs the CLI emitter and does not contradict the `001` progress-event forward-compatibility note (which governs consumers). PASS
- **No `org_id` ever sent.** spec FR-027/FR-023, plan Constitution Check II, and tasks T005/T024 agree. PASS
- **No new deps / no new persistent state.** spec Assumptions, plan Technical Context, `data-model.md` preamble, and tasks Notes all agree. PASS

---

## 3. Cloud-contract fidelity (vs. `003`)

Diffed the consumer contracts against `poppi/specs/003-org-membership-permissions/contracts/`:

- `POST /api/join` request `{code}`, success `{org:{id,name,slug}, membership:{id,role,joined_at}}`, and the full error table (`400 validation_failed`, `401 unauthorized`, `404 not_found`, `409 already_member`, `409 wrong_org`, `410 expired|revoked|exhausted`, `426 upgrade_required`, `429 rate_limited`, `500 internal`) -- exact match with cloud `join.md`. PASS
- `wrong_org` `details` field names (`current_org_name`, `current_org_slug`, `target_org_name`) -- exact match with cloud `join.md`. PASS
- `rate_limited` -- `Retry-After` header + `details.retry_after_seconds` -- exact match with cloud `join.md`. The CLI's "prefer header, fall back to body" rule (R-5) is consistent with the cloud setting both. PASS
- `GET /api/orgs/me` success `{org:{id,name,slug,member_count,created_at}, membership:{role,joined_at}}` and `409 org_required` -- exact match with cloud `orgs.md`. PASS
- Auth model (bearer JWT, `401 unauthorized`, no HTML redirect on API routes) -- matches cloud `README.md` cross-cutting Auth/Onboarding-gate rules. PASS

---

## 4. Findings and fixes

### Finding A (RESOLVED) -- FR-023 lacked an explicit task anchor

FR-023 ("`join` does NOT process session data; `redaction_policy_version` MUST NOT appear in the `/api/join` body") was implied by T005 but not named, risking an "every FR maps to a task" gap on a literal reading. Resolved by anchoring FR-023 to T005 (request body is only `{code}`) + T009 (contract test asserts body shape) in the traceability matrix above. No behavioural change; T005/T009 already cover it.

### Finding B (RESOLVED) -- `already_member` consumer contract scoped to the cloud's documented `message`

The cloud `join.md` documents an explicit error-body example only for `wrong_org` and `rate_limited`; for `409 already_member` it documents the status + `error` code but no body example naming the org. To avoid asserting an undocumented `org` field, `contracts/join.md` and `research.md` R-2 were written so the CLI prints the cloud's standard-shape `message` verbatim for `already_member` (the cloud's universal error shape is `{error, message, details?}` per `README.md`), keeping the CLI within the cloud's documented contract surface.

### Finding C (NO CHANGE -- documented inference) -- org-naming in the `already_member` message

spec US1-4 / FR-017 require the CLI to name the org in the "already a member" line; the CLI obtains that name from the cloud's `already_member` `message`, for which `join.md` shows no explicit example (unlike `wrong_org`). This is a reasonable, low-risk consumer inference, consistent with the cloud's error shape and the parallel `wrong_org` message. It is already documented as an assumption in `contracts/join.md` and `research.md` R-2 and is in scope for the FR-033 cross-repo coordination. No artifact change; flagged for the cloud team to confirm the `already_member` `message` names the org at PR time. Fallback if not: cloud adds `details.org_name`, or the CLI prints a generic "You are already a member of this organization." -- neither alters exit codes or scope.

---

## 5. Constitution re-check

Re-evaluated all six principles against the final artifact set (matches plan.md's Constitution Check):

- **I (Waste-Reduction)** PASS -- join is the on-ramp to org-scoped waste aggregation.
- **II (Multi-Tenant)** PASS -- CLI never sends `org_id`; `401`/`403` mid-upload hard-fails (T025), no cross-tenant degrade.
- **III (Supabase Auth)** PASS -- consumes cloud HTTP endpoints with the bearer JWT; no embedded `supabase-js`.
- **IV (shadcn)** PASS N/A -- no React surface.
- **V (Pre-Commit + Local Parity)** PASS -- no new tool; `--endpoint` exercises every flow against the local Docker stack (quickstart section 1, T034); tasks Notes reiterate the `--no-verify` ban.
- **VI (Fail-Closed / Honest Failures)** PASS -- join touches no session data (FR-023); the org-gate fires before anonymization (T024, never weakens the trust gate); contract drift -> `GENERIC_FAILURE` (T009/T016/T031); no silent retries on auth/version-gate/rate-limit (T018); no-org state reported honestly (T021).

No violations; Complexity Tracking remains empty.

---

## 6. Summary

- **Coverage**: 33/33 FRs, 6/6 user stories, 9/9 SCs traced to tasks.
- **Internal consistency**: exit codes, idempotency mapping, `org_required` dual-interpretation, `--json` additivity, and the no-`org_id`/no-new-deps/no-new-state invariants are consistent across all artifacts.
- **Cloud fidelity**: all consumed request/response/error shapes and `details` field names match the authoritative cloud `003` contracts.
- **Fixes**: Finding A (traceability anchor for FR-023) and Finding B (`already_member` consumer contract scoped to the cloud's documented `message` shape) resolved. Finding C is a documented, justified inference flagged for cross-repo confirmation at PR time -- not a blocker and not a scope change.
- **Constitution**: all six principles pass; no Complexity Tracking entries.

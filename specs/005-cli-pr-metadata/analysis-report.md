# Cross-Artifact Analysis Report: 005-cli-pr-metadata

**Feature**: 005-cli-pr-metadata | **Date**: 2026-05-24 | **Mode**: non-destructive consistency analysis (`/speckit-analyze`)

**Artifacts analysed**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/` (`manifest-gitcontext.md`, `manifest-entry.gitcontext.schema.json`, `progress-event.gitcontext.md`), `quickstart.md`, `tasks.md`, plus the cross-repo references (`001-cli-ingest-client/` contracts/plan, cloud `005` FR-024/028, constitution v2.0.0).

---

## 1. Summary verdict

The artifact set is **internally consistent and complete**. Every functional requirement (FR-001..FR-016) maps to at least one task; every task traces to a requirement; every success criterion (SC-001..SC-007) has a dedicated test task; every user story (US1..US4) has a phase with an independent test. The Constitution Check correctly identifies Principle VI as the primary gate and justifies the opt-in/fail-closed/auditable posture rather than ERRORing. The manifest extension is genuinely additive (optional property, `additionalProperties:false` preserved by adding the property, no `001` field touched).

One **MINOR** inconsistency was found and **fixed** during analysis (wire vs. contract field-name ambiguity, §3). No **CRITICAL** or **HIGH** issues. No scope expansion was introduced.

---

## 2. Coverage matrices

### 2.1 Requirement -> task (every FR is implemented)

| FR     | Tasks                  | FR     | Tasks                  |
| ------ | ---------------------- | ------ | ---------------------- |
| FR-001 | T007, T014             | FR-009 | T006, T022, T024       |
| FR-002 | T008, T009, T010       | FR-010 | T003, T013, T016       |
| FR-003 | T004, T005, T007, T014 | FR-011 | T002, T016, T026       |
| FR-004 | T002, T006, T015       | FR-012 | T013, T027, contracts/ |
| FR-005 | T006, T012             | FR-013 | T017                   |
| FR-006 | T002, T006, T011       | FR-014 | T018, T019, T020       |
| FR-007 | T006, T011             | FR-015 | T010, T012, T017, T019 |
| FR-008 | T006, T021, T022, T023 | FR-016 | T025, T027             |

All 16 FRs covered.

### 2.2 Success criterion -> test task

| SC                                 | Test task(s)                                            |
| ---------------------------------- | ------------------------------------------------------- |
| SC-001 (default-off provable)      | T008 (filesystem + network spy, resolver never entered) |
| SC-002 (opt-in completeness)       | T011 (resolution matrix)                                |
| SC-003 (credential fail-closed)    | T012, T018                                              |
| SC-004 (auditable, 0 bytes)        | T018, T020                                              |
| SC-005 (graceful degradation)      | T021, T022                                              |
| SC-006 (additive, backward-compat) | T013, T027                                              |
| SC-007 (no ledger churn)           | T026                                                    |

All 7 SCs have a dedicated, test-first task.

### 2.3 User story -> phase + independent test

| US                         | Priority | Phase                                       | Independent test present |
| -------------------------- | -------- | ------------------------------------------- | ------------------------ |
| US2 (default-off)          | P1       | Phase 3 (verified first as the safety gate) | yes                      |
| US1 (opt-in / MVP)         | P1       | Phase 4                                     | yes                      |
| US3 (audit before send)    | P1       | Phase 5                                     | yes                      |
| US4 (graceful degradation) | P2       | Phase 6                                     | yes                      |

All 4 stories covered. The deliberate ordering (US2 default-off proven before US1 opt-in is wired) is documented in the tasks header and the dependency section, and is justified: a default-path privacy regression is the highest-severity failure for this feature.

### 2.4 Task -> requirement (no orphan tasks)

Every task carries a `per FR-NNN`/`per SC-NNN`/`per data-model`/`per contracts/` citation. Setup tasks (T001-T003) are additive seams justified by FR-004/006/010/011. No task introduces behaviour outside the spec's scope.

---

## 3. Findings and fixes

### F1 (MINOR - FIXED) - wire vs. public-contract field-name ambiguity

- **Where**: `contracts/manifest-gitcontext.md` Section 1.
- **Problem**: The doc stated the wire request body carries `git_context` "of the shape above," but the shape shown used camelCase `commitSha`, while `tasks.md` T003 correctly specified the snake_case wire shape `{ ..., commit_sha }`. This conflated the public-contract shape (camelCase `gitContext`/`commitSha`, as surfaced in the manifest/stdout/`--json` and the schema fragment) with the HTTP request body (snake_case `git_context`/`commit_sha`).
- **Fix applied**: Edited Section 1 to state explicitly that the wire inner keys are snake_case (`commit_sha`, not `commitSha`) and that the camelCase form is the public manifest/stdout contract shape. Noted this mirrors the existing `001` split (contract `manifestId` <-> wire `upload_id`; contract `redactionPolicyVersion` <-> wire `redaction_policy_version`), so it is the established convention, not a new one.
- **Status**: Resolved. `tasks.md`, `data-model.md` Section 5, and the schema fragment were already consistent with the corrected statement; no further edits needed.

### F2 (INFO - no change) - `FR-018` appears in tasks but is an `001` FR

- **Where**: `tasks.md` T020 cites "FR-014 (`001` FR-018)".
- **Assessment**: This is correct, not an error. FR-018 belongs to `001` (dry-run transmits nothing); the `005` spec's FR-014 explicitly references it (`001` FR-018). The citation is properly attributed as a cross-spec reference. No fix.

### F3 (INFO - no change) - optional persisted-config command surface (`config set`) is illustrative

- **Where**: `quickstart.md` Section 7 shows `poppi config set linkPrs true`.
- **Assessment**: FR-003 says the CLI **MAY** persist the opt-in and requires it be discoverable; it does not mandate a `config` subcommand. `quickstart.md` Section 7 and `tasks.md` T004 both hedge the exact surface ("exact surface per implementation"). This is consistent with the spec's MAY and does not over-commit. No fix; flagged so implementers know the command name is not contractually fixed.

---

## 4. Consistency checks (all pass)

- **Privacy posture coherent across artifacts**: spec crux -> plan Constitution Check VI deep-dive -> research R-4/R-6/R-7 -> data-model invariants (fail-closed, hard-gate, no-churn) -> contracts (credential-/path-free) -> tasks (T008/T012/T026 lock them). The "opt-in + fail-closed + auditable" triad is stated identically everywhere.
- **No-ledger-churn (FR-011/SC-007) is structurally guaranteed, not just tested**: `data-model.md` Section 5 and `contracts/manifest-gitcontext.md` Section 4 both anchor it to `001`'s `contentHash = redactedHashHex` (which excludes git context); `tasks.md` T002/T016 keep `cwd`/`gitContext` out of `records`/payload; T026 asserts it. Verified against the real `src/ledger/classify.ts` (compares `result.redactedHashHex` to `existing.contentHash`) and `src/anonymize` input (`parsed.records` only).
- **Additive manifest extension is genuine**: the schema fragment adds an optional `gitContext` property and keeps `additionalProperties:false`; `manifest-gitcontext.md` Section 2 explains the additive-merge mechanism; SC-006 backward-compat test (T013) enforces it. Consistent with `001` FR-036 and the `001` `progress-event` forward-compat note.
- **`cwd`/`gitBranch` derivation is grounded in reality**: research R-1 / data-model Section 4 / tasks T002 assume Claude Code JSONL records carry `cwd` and `gitBranch`; this was confirmed against a live `~/.claude/projects/**/*.jsonl` record (`cwd=/Users/.../poppi-cli`, `gitBranch=main`). The plan does not depend on instrumentation that doesn't exist.
- **Cloud contract alignment**: the `gitContext` shape (host + owner/name + branch + commit) is exactly what cloud `005` FR-024 consumes ("branch, commit SHA, or explicit PR reference ... supplied at upload time by the CLI"); the "no PR metadata -> excluded from denominator" degradation matches cloud `005` Edge Cases / FR-028; the reserved `pr_id` storage key is correctly described as cloud-owned and deferred.
- **No new exit code**: spec Assumptions, plan Constraints, and tasks T024/T028 all assert this consistently; no task adds to the `001`/`004` exit-code table.
- **Read-only / no-hooks guarantee**: research R-2 (read `.git/` files, never spawn `git`) is reflected in data-model Section 2 (resolver never throws) and tasks T006; consistent with FR-004 and the spec Edge Case "must not trigger side effects."

---

## 5. Constitution alignment (re-confirmed)

The plan's Constitution Check evaluates all six principles, marks III/IV N/A (no React/auth surface), and correctly treats **VI** as the primary gate with a four-point justification (opt-in default-off, fail-closed credential strip, auditable before send, honest global notices), each mapped to an FR and an SC. This is the principle operating as designed - a consented, fail-closed, auditable departure - not a violation. The Complexity Tracking section is correctly empty. No constitutional contradiction exists in any downstream artifact.

---

## 6. Outcome

- **CRITICAL**: 0
- **HIGH**: 0
- **MEDIUM**: 0
- **MINOR**: 1 (F1 - fixed)
- **INFO**: 2 (F2, F3 - no change needed)

The feature's planning artifacts are coherent, complete, and ready for `/speckit-implement`. The single fix applied (F1) removed a wire/contract field-name ambiguity so an implementer cannot mis-name the HTTP body field.

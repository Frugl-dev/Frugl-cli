# Tasks: frugl-cli v1 — Public OSS Ingest Client

**Input**: Design documents from `/specs/001-cli-ingest-client/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story. User Story 2 (anonymizer) is implemented before User Story 1 (upload) because FR-009 requires every byte through the anonymizer before network transmission — US1's independent test cannot pass until the anonymizer is complete.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to ([US1]–[US4])
- Each description includes the exact target file path

---

## Phase 1: Setup (Migration + oclif Scaffold)

**Purpose**: Migrate the existing scaffold from commander/prompts/keytar/supabase-js to oclif and the spec-locked dependency set. All migration tasks are prerequisites for every subsequent phase.

- [x] T001 Migrate package.json: remove commander, prompts, keytar, @supabase/supabase-js, @types/prompts; add @oclif/core, oclif, @inquirer/prompts, @napi-rs/keyring, zod, semver, p-retry, p-limit, conf, env-paths, tinyglobby, picocolors; run pnpm install to sync lockfile in package.json
- [x] T002 [P] Create bin/run.js as the oclif production entrypoint (shebang, oclif bootstrap) in bin/run.js
- [x] T003 [P] Create bin/dev.js as the oclif tsx-based dev entrypoint in bin/dev.js
- [x] T004 Delete src/commands/delete.ts (deferred to spec 002-delete per research.md R-17) and src/cli.ts (replaced by oclif scaffold)
- [x] T005 Create src/index.ts as oclif runtime glue: re-export all Command classes so oclif auto-discovery finds them in src/index.ts
- [x] T006 Update package.json oclif metadata block: oclif.commands = "src/index.ts", oclif.bin = "frugl"; update scripts to oclif conventions: dev → "tsx bin/dev.js", build → "tsup src/index.ts --outDir dist", prepack → "npm run build"; confirm pnpm typecheck + pnpm test still pass after script migration in package.json

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Cross-cutting infrastructure that MUST exist before any user story can be implemented. Includes the exit-code table, error classes, output-mode plumbing, storage paths, retry wrapper, cloud HTTP boundary, keychain backend, and the ledger + classification modules (needed by the upload orchestrator).

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T007 [P] Create src/lib/exit-codes.ts with frozen EXIT constant table (OK=0, GENERIC_FAILURE=1, USAGE=2, AUTH_FAILURE=10, KEYCHAIN_UNAVAILABLE=11, NO_SESSIONS_FOUND=20, ANONYMIZATION_FAILURE=30, NETWORK_FAILURE=40, ENDPOINT_UNREACHABLE=41, VERSION_GATE_FAILURE=50, INSPECT_DIR_EXISTS=60) per data-model.md §13 / FR-037 in src/lib/exit-codes.ts
- [x] T008 [P] Create src/lib/errors.ts with typed error classes (AuthError, KeychainError, AnonymizationError, NetworkError, VersionGateError, EndpointError, NoSessionsError, InspectDirError) each carrying an EXIT code per FR-037 in src/lib/errors.ts
- [x] T009 [P] Create src/lib/output-mode.ts defining OutputMode = 'text' | 'json' type and a resolveOutputMode(flags) helper (threaded through commands as an explicit parameter per research.md R-11) in src/lib/output-mode.ts
- [x] T010 [P] Create src/lib/paths.ts resolving the env-paths state-dir locations for the two conf namespaces frugl-resume-state and frugl-ledger (XDG_STATE_HOME / ~/Library/Application Support / %APPDATA% per R-9) in src/lib/paths.ts
- [x] T011 [P] Create src/lib/retry.ts: p-retry wrapper with 3 attempts, factor 2, base 500 ms, full jitter, 5 s cap (R-2); shouldRetry predicate rejects HTTP 401/403/426 and all non-transient 4xx per FR-029a/b in src/lib/retry.ts
- [x] T012 [P] Create src/cloud/endpoints.ts: resolve target Endpoint from --endpoint flag > FRUGL_ENDPOINT env > default https://api.frugl.app; validate URL scheme (https or localhost http only); record resolvedFrom field per R-13 in src/cloud/endpoints.ts
- [x] T013 Create src/cloud/schemas.ts: zod schemas for every cloud response type (OTP request, OTP verify, whoami, manifest create, presign, completion) matching contracts/cloud-api.md; derived TypeScript types exported alongside each schema per FR-036 in src/cloud/schemas.ts
- [x] T014 Create src/cloud/version-gate.ts: parse 426 response body for minVersion; use semver.lt(cliVersion, minVersion) to decide; format upgrade message (current, required, npm install command) per FR-033 in src/cloud/version-gate.ts
- [x] T015 Create src/cloud/client.ts: thin native fetch wrapper attaching CLI-version header (FR-032), per-request AbortController timeouts (8 s control-plane / 60 s body PUT per R-3), version-gate intercept on 426, auth bearer token injection; catch ZodError from schema parsing (T013) and rethrow as a typed error mapped to EXIT.GENERIC_FAILURE so cross-repo contract drift surfaces as a stable, grep-able exit rather than an unhandled rejection per FR-036 in src/cloud/client.ts
- [x] T016 Update src/auth/keychain.ts to replace keytar with @napi-rs/keyring while preserving the existing getToken/setToken/deleteToken/SERVICE API surface; surface KeychainError(EXIT.KEYCHAIN_UNAVAILABLE) when secret service is unavailable per FR-004/005 in src/auth/keychain.ts
- [x] T017 [P] Create src/ledger/ledger.ts: conf-backed Ledger keyed by (endpointUrl, userId); zod schema for LedgerEntry and Ledger shapes (schemaVersion=1); atomic reads and writes via conf; schema-version mismatch → ledger-loss recovery path per FR-006c/f/g in src/ledger/ledger.ts
- [x] T018 [P] Create src/ledger/classify.ts skeleton: implement `new` case (sessionId absent from ledger) and stub `unchanged`/`updated` returning `new` as placeholder; define classifySession(ref, identity, ledger) → SessionClassification signature; add ordering helpers (mtime desc, path asc tiebreaker per R-1) per FR-006d in src/ledger/classify.ts — `unchanged`/`updated` hash-comparison logic is completed in T018b (Phase 3) after the anonymizer exists

**Checkpoint**: Foundation ready — all user story phases can now begin. T018 (classify.ts) delivers a `new`-only skeleton; the `unchanged`/`updated` hash-comparison is completed in T018b (Phase 3) once the anonymizer exists.

---

## Phase 3: User Story 2 — Provable Anonymization (Trust Gate) (Priority: P1)

**Goal**: Implement the complete anonymizer with all redaction rules, pseudonym generation, policy versioning, and the planted-secrets test suite; also complete T018b (classify.ts `unchanged`/`updated` cases) which depends on the anonymizer. This phase must be complete before User Story 1's independent test can pass (FR-009: every byte anonymized before transmission).

**Independent Test**: Run `pnpm test src/anonymize/` on the planted-secrets fixture. For a session containing one planted value per supported redaction category (Anthropic key, OpenAI key, AWS key, GCP key, GitHub token, Slack webhook, .env line, home path, third-party email, high-entropy string), every planted value must be absent from the post-anonymization output and the summary must record exactly one redaction per category (SC-001).

- [x] T019 [P] [US2] Create src/anonymize/policy.ts with POLICY_VERSION = 'v0.1' string constant and RedactionCategory union type export; MAJOR bumps on rule removal/weakening, MINOR on addition per R-12 in src/anonymize/policy.ts
- [x] T020 [P] [US2] Create src/anonymize/pseudonyms.ts: PseudonymTable class seeded with uploadId via HMAC-SHA-256; pseudonymize(category, realValue) returns category-prefixed deterministic string (proj_xxx / user_xxx); same input → same output within instance; different uploadId → different output per R-16 / FR-016 in src/anonymize/pseudonyms.ts
- [x] T021 [P] [US2] Create src/anonymize/rules/secrets.ts: regex-based redaction for Anthropic API keys (sk-ant-_), OpenAI API keys (sk-_), AWS access keys (AKIA\*), GCP service-account JSON keys, GitHub tokens (ghp*/github_pat*), Slack webhook URLs (hooks.slack.com), and .env-style KEY=VALUE lines per FR-010 in src/anonymize/rules/secrets.ts
- [x] T022 [P] [US2] Create src/anonymize/rules/claude-paths.ts: redact absolute paths under $HOME → <HOME> token; extract project/directory name components and replace with PseudonymTable stable pseudonyms per FR-011 in src/anonymize/rules/claude-paths.ts
- [x] T023 [P] [US2] Create src/anonymize/rules/emails.ts: preserve the authenticated user's own email (ownerEmail from AuthSession); pseudonymize all other RFC-5321 email addresses with PseudonymTable stable per-upload pseudonyms per FR-011/012 in src/anonymize/rules/emails.ts
- [x] T024 [P] [US2] Create src/anonymize/rules/entropy.ts: compute per-character Shannon entropy for candidate strings ≥ 20 characters; flag + redact values with entropy ≥ 4.5 bits/char that match no other rule (fail-closed fallback per FR-013/014) in src/anonymize/rules/entropy.ts
- [x] T025 [US2] Implement src/anonymize/index.ts public anonymize(session, opts) API: apply rules in order (secrets → claude-paths → emails → entropy), collect per-category counts, produce AnonymizationResult with payload/redactionsByCategory/policyVersion/redactedHashHex/byteSize; fail-closed on any ambiguous value; abort entire batch on failure per FR-009/014/015 in src/anonymize/index.ts
- [x] T018b [US2] Complete src/ledger/classify.ts `unchanged`/`updated` cases (depends on T025): call anonymize() to compute currentRedactedHashHex; compare to ledger contentHash — matching → unchanged, differing → updated; discard AnonymizationResult for unchanged sessions immediately; this finishes the classifySession() implementation started in T018 per FR-006d / data-model.md §8 in src/ledger/classify.ts
- [x] T026 [US2] Complete src/anonymize/anonymize.test.ts: add PLANTED fixture table with one value per RedactionCategory; assert 100% absent from JSON.stringify(payload); assert per-category count = 1; assert owner email preserved; assert same pseudonym for repeated project name across sessions in same upload per SC-001 / FR-012 / FR-016 in src/anonymize/anonymize.test.ts

**Checkpoint**: Anonymizer is complete, all planted-secrets tests pass, and classify.ts `unchanged`/`updated` cases are fully implemented (T018b). User Story 1 upload pipeline can now be implemented.

---

## Phase 4: User Story 1 — First Successful Upload (Priority: P1) 🎯 MVP

**Goal**: Implement the four user-facing commands (login, logout, whoami, upload) and all supporting modules (source discovery, identity derivation, upload pipeline, progress output, pre-upload summary). On completion, the full login → upload → dashboard loop works against the local stack.

**Independent Test**: On a clean machine with sample Claude Code session logs under ~/.claude/projects/ and the local stack running (`pnpm stack:up`), run `FRUGL_ENDPOINT=http://localhost:54321 pnpm dev login` then `pnpm dev upload --confirm`. Expect: exit 0, manifest ID printed to stdout, dashboard renders sessions under the authenticated user. Full loop ≤ 60 s on broadband (SC-003).

- [x] T027 [P] [US1] Create src/sources/types.ts with Source interface (kind, discover, parse, deriveIdentity), SessionRef, SessionIdentity, and ParsedSession type shapes per data-model.md §3–4 in src/sources/types.ts
- [x] T028 [P] [US1] Create src/sources/claude-code/discover.ts: tinyglobby glob ~/.claude/projects/\*_/_.jsonl; return SessionRef[] with absolutePath (path.resolve), byteSizeOnDisk (fs.stat), mtimeMs per FR-006 in src/sources/claude-code/discover.ts
- [x] T029 [P] [US1] Create src/sources/claude-code/identity.ts: read sessionId from first JSONL record; fallback to sha256(canonicalize(path))[:24] with derivation='path-hash' when native sessionId is absent or malformed per FR-006b / R-10 in src/sources/claude-code/identity.ts
- [x] T030 [P] [US1] Create src/sources/claude-code/parse.ts: stream-read JSONL file, parse each line as JSON, assemble ClaudeCodeParsedSession (sourceKind, ref, identity, records[]) per data-model.md §4 in src/sources/claude-code/parse.ts
- [x] T031 [P] [US1] Create src/sources/registry.ts: SourceRegistry exporting built-in sources array (v1: [claudeCode]); structured as the FR-007 extension seam for future source adapters in src/sources/registry.ts
- [x] T032 [US1] Create src/auth/otp-flow.ts: requestOTP(email, endpoint) → cloud OTP-request call; verifyOTP(email, code, endpoint) → cloud OTP-verify call → returns AuthSession (email, userId, token, endpointUrl, loggedInAt) per FR-001 / data-model.md §1 in src/auth/otp-flow.ts
- [x] T033 [US1] Create src/commands/login.ts as oclif Command: @inquirer/prompts for email input and masked 6-digit code; call otp-flow; store AuthSession in keychain; emit CommandResult JSON on --json; exit AUTH_FAILURE on bad code per FR-001 / FR-040 in src/commands/login.ts
- [x] T034 [US1] Create src/commands/logout.ts as oclif Command: load AuthSession from keychain; call cloud sign-out endpoint; delete keychain entry; emit CommandResult JSON on --json; succeed even if cloud call fails (best-effort) per FR-002 / FR-040 in src/commands/logout.ts
- [x] T035 [US1] Create src/commands/whoami.ts as oclif Command: load AuthSession from keychain; print email/userId/endpoint/loggedInAt; on missing/invalid session emit ok:false reason:'not-logged-in' and exit AUTH_FAILURE; --json CommandResult per FR-003 / FR-040 in src/commands/whoami.ts
- [x] T036 [US1] Create src/upload/summary.ts: build UploadSummary from classified sessions (discovered count, unchanged count, new count, updated count, will-upload count, date range, estimated compressed size, redaction policy version, endpoint); format for @inquirer/prompts confirmation display per FR-020 / FR-020a / FR-020b in src/upload/summary.ts
- [x] T037 [US1] Create src/upload/progress.ts: stderr text progress lines ("[N/M] sessionId — uploading X KB") in text mode using picocolors; stdout NDJSON ProgressEvents with monotonic seq in json mode; emit upload-start, session-start, session-acked, session-failed, session-skipped, upload-complete event types per FR-038 / FR-039 / data-model.md §11 in src/upload/progress.ts
- [x] T038 [US1] Create src/upload/pipeline.ts: p-limit (default 4 concurrency) pool; per session: obtain presigned URL → gzip payload → PUT with retry wrapper → cloud ack; write per-session acknowledgment to ResumeState immediately on ack (FR-025b); update ledger entry after ack (FR-006e); surface errors with typed error classes per FR-022 / FR-023 / FR-025a in src/upload/pipeline.ts
- [x] T039 [US1] Create src/commands/upload.ts as oclif Command orchestrator: resolve endpoint → load auth → discover sessions → classify (ledger) → sort mtime-desc + --limit truncation → anonymize batch → display summary → @inquirer/prompts confirm (skip with --confirm/--yes) → run pipeline → call completion endpoint → print manifestId and dashboardUrl → exit 0; define all flags (--dry-run, --inspect [dir], --confirm, --yes, --endpoint, --json, --concurrency N, --limit N); pass Source.kind as `source_kind` in manifest-create payload (FR-008); manifest-create call MUST NOT be retried on timeout or response-loss — surface a clear error and exit on any manifest-create failure so a re-run can resume cleanly (a retry could create a second orphaned manifest per FR-029d) per FR-006a / FR-008 / FR-020 / FR-021 / FR-024 / FR-025 / FR-029d in src/commands/upload.ts

**Checkpoint**: All four commands work against the local stack. `pnpm dev login && pnpm dev upload --confirm` exits 0 and the dashboard reflects the upload.

---

## Phase 5: User Story 3 — Incremental Upload Over Time (Priority: P1)

**Goal**: Verify and test the classification + ledger logic so that re-running `frugl upload` after a first upload only transmits the (new ∪ updated) subset. The upload orchestrator already calls classify() from Phase 2; this phase adds the test coverage and validates the incremental behavior end-to-end.

**Independent Test**: After a successful first upload of M sessions, add K new session files to disk and append turns to L existing files. Run `frugl upload` again. Pre-summary reports M−L unchanged, K new, L updated. Bytes transmitted = redacted size of K+L sessions only. Cloud reports M+K distinct sessionIds (FR-006b updated sessions reuse their original sessionId).

- [x] T040 [P] [US3] Write src/ledger/classify.test.ts: unit tests for classifySession() covering unchanged (sessionId in ledger, hash matches), new (not in ledger), updated (in ledger, hash differs), ledger-loss path (all return new), and --limit ordering (mtime desc, path asc tiebreaker) per FR-006d / R-1 in src/ledger/classify.test.ts
- [x] T041 [P] [US3] Write ledger unit tests in src/ledger/ledger.test.ts: atomic write (conf temp-rename), schema-version mismatch treated as ledger loss (no exit failure), entry CRUD, privacy invariant (no external serialization path) per FR-006c / FR-006f / FR-006g in src/ledger/ledger.test.ts
- [x] T042 [US3] Validate incremental classification integration in src/commands/upload.ts: pre-summary breakdown shows discovered/unchanged(skipping)/new/updated/will-upload counts; --limit N applied to the (new ∪ updated) subset after classification (not to all discovered); emit "No new or updated sessions" and exit 0 when will-upload = 0 per FR-006a / FR-020b / FR-029 in src/commands/upload.ts
- [x] T043 [US3] Add incremental scenario test to src/ledger/classify.test.ts: simulate M sessions uploaded (populated ledger), K new files added, L existing files modified; assert classify() returns M−L unchanged, K new, L updated; assert updated sessions carry same sessionId as prior ledger entry per FR-006d / FR-006e in src/ledger/classify.test.ts

**Checkpoint**: Incremental upload works correctly. Second run after a clean first upload transmits only new/updated sessions.

---

## Phase 6: User Story 4 — Resumable Upload After Interruption (Priority: P1)

**Goal**: Implement resume state persistence so that a killed or interrupted upload can be continued from the next unacknowledged session on re-run, using the same manifest identifier.

**Independent Test**: Begin an upload of M sessions; forcibly kill the CLI after N sessions are acknowledged. Re-run `frugl upload`. CLI detects in-flight state, reuses existing manifestId, transmits only M−N remaining sessions. Completion call reports M total. Zero duplicate PUTs. Single manifestId across both runs (SC-005).

- [x] T044 [P] [US4] Create src/upload/resume.ts: ResumeState conf namespace frugl-resume-state; persist/load/clear ResumeState (manifest + beganAt); zod schema with schemaVersion=1; schema-version mismatch → start fresh (no failure); detect stale uploadId when cloud returns 404 on resumption attempt per FR-026 / FR-027a / data-model.md §10 in src/upload/resume.ts
- [x] T045 [US4] Integrate resume into src/upload/pipeline.ts: on pipeline startup, check for persisted ResumeState; if found, skip already-acked entries (FR-027c); for each pending entry verify source file still present and raw hash matches (FR-027b); skip missing/modified with stderr warning; continue remaining unacknowledged sessions; clear ResumeState on successful completion endpoint call (FR-028); add vitest test simulating N-of-M ack then re-run and asserting each sessionId's presigned PUT is issued exactly once across both runs (SC-005 zero-duplicate-PUTs invariant) in src/upload/pipeline.ts
- [x] T046 [US4] Update src/commands/upload.ts: on FR-027a (cloud returns stale uploadId), discard ResumeState, print notice naming lost manifestId, start fresh manifest; on FR-029c (retry exhausted), exit NETWORK_FAILURE, preserve ResumeState, print "re-run frugl upload to resume" message per FR-027a / FR-028 / FR-029c in src/commands/upload.ts

**Checkpoint**: Resumable upload works. Interrupted upload completes cleanly on re-run with no duplicate PUTs.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, --dry-run --inspect path, targeted unit tests for retry/version-gate, and end-to-end SC-004 validation.

- [x] T047 [P] Implement --dry-run --inspect dir handling in src/commands/upload.ts: write per-session redacted payload + redaction-summary JSON to inspection dir (default ./frugl-inspect/); serialize redaction summary from AnonymizationResult.redactionsByCategory validated against contracts/redaction-summary.schema.json (same zod approach as cloud responses in T013) so the on-disk summary is a stable public contract per FR-036; refuse to overwrite existing dir without --force (exit INSPECT_DIR_EXISTS=60); transmit zero bytes when --dry-run is set per FR-018 / FR-019 / FR-036 in src/commands/upload.ts
- [x] T048 [P] Add edge case error handling in src/commands/upload.ts: no sessions discovered → print search dir + source kind → exit NO_SESSIONS_FOUND(20); keychain unavailable → exit KEYCHAIN_UNAVAILABLE(11); explicit --endpoint unreachable → exit ENDPOINT_UNREACHABLE(41) with no fallback; expired/revoked token → exit AUTH_FAILURE(10) with re-login instructions per spec Edge Cases in src/commands/upload.ts
- [x] T049 [P] Write src/lib/retry.test.ts: assert transient errors (network reset, HTTP 500, HTTP 429, timeout) ARE retried up to 3 attempts; assert HTTP 401/403/426 and other 4xx are NOT retried and fail immediately per FR-029a/b in src/lib/retry.test.ts
- [x] T050 [P] Write src/cloud/version-gate.test.ts: assert semver.lt comparison correctly identifies below-minimum CLI; assert upgrade message includes current version, required version, and npm install command per FR-033 in src/cloud/version-gate.test.ts
- [x] T051 Run and verify the SC-004 end-to-end validation loop against local stack (login → whoami → dry-run inspect → upload --confirm → incremental re-run → limit 1 → logout → whoami = not-logged-in) matching quickstart.md section 8; confirm all exit codes per contracts/exit-codes.md; assert zero outbound network calls during a --dry-run invocation (FR-034/035 no-telemetry invariant, verifiable by capturing fetch calls in the test environment); time the classification step against M=1000 session fixtures and assert ≤ 5 s (SC-003a); time the full upload --confirm loop against ≤ 200 sessions on the local stack and assert ≤ 60 s (SC-003). Implemented: SC-003a classify timing (1000 sessions in ~106 ms, ≤5 s ✓) in src/ledger/classify.test.ts; zero dry-run network (recording HTTP server asserts 0 requests, FR-018 ✓) + SC-004 ordered mock-server sequence (whoami→dry-run→upload→noop→limit1→logout→whoami=10 ✓) + SC-003 mock-server timing (200 sessions ~14 s, ≤60 s ✓) in src/e2e/cli.e2e.test.ts; Docker-stack integration suite in src/e2e/docker-stack.e2e.test.ts (requires FRUGL_DOCKER_STACK=1, TEST_ASTRO_URL, TEST_SUPABASE_URL, TEST_SUPABASE_SECRET_KEY — see file header for setup).
- [x] T052 [P] Update README.md with install instructions (npm i -g frugl / npx frugl), link to quickstart.md, and remove any references to the deleted delete command in README.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — begin immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user story phases
- **User Story 2 / Anonymizer (Phase 3)**: Depends on Phase 2
- **User Story 1 / First Upload (Phase 4)**: Depends on Phase 3 (anonymizer must be complete per FR-009)
- **User Story 3 / Incremental (Phase 5)**: Depends on Phase 4 (upload pipeline must exist for classify integration tests to run end-to-end)
- **User Story 4 / Resume (Phase 6)**: Depends on Phase 4 (extends pipeline.ts and upload.ts from US1)
- **Polish (Phase 7)**: Depends on all story phases completing

### User Story Dependencies

- **US2 (Anonymizer)**: No dependencies beyond Foundational — can start immediately after Phase 2
- **US1 (First Upload)**: Depends on US2 (anonymizer is a prerequisite per FR-009); all other US1 modules (sources, auth commands, pipeline) can be built in parallel while US2 is being tested
- **US3 (Incremental)**: Depends on US1 (classification is wired into upload.ts from Phase 4)
- **US4 (Resume)**: Depends on US1 (extends pipeline.ts and upload.ts from Phase 4)

### Within Each Phase

- Tasks marked [P] can be worked on simultaneously (different files, no intra-task dependency)
- Non-[P] tasks within a phase run sequentially (T038 pipeline before T039 upload command, etc.)
- Complete each phase's checkpoint before advancing to the next phase
- T018b (classify.ts `unchanged`/`updated` logic) lives in Phase 3 because it depends on T025 (anonymize/index.ts); T018 (skeleton) is in Phase 2

### Parallel Opportunities

```bash
# Phase 2: all [P] tasks run simultaneously
# T007 exit-codes.ts | T008 errors.ts | T009 output-mode.ts | T010 paths.ts | T011 retry.ts
# T012 endpoints.ts  | T017 ledger.ts | T018 classify.ts skeleton  (after T013-T016 unlock schemas/client/keychain)
# T018b (classify unchanged/updated) runs in Phase 3 after T025 (anonymizer)

# Phase 3: anonymizer rules run simultaneously after T019+T020
# T021 secrets.ts | T022 claude-paths.ts | T023 emails.ts | T024 entropy.ts

# Phase 4: source modules and command skeletons run simultaneously
# T027 types.ts | T028 discover.ts | T029 identity.ts | T030 parse.ts | T031 registry.ts
# Then T032 otp-flow → T033-T035 commands in parallel | T036 summary | T037 progress | T038 pipeline → T039 upload

# Phase 5: test files run simultaneously
# T040 classify.test.ts | T041 ledger.test.ts  (T042/T043 sequential after T040/T041)
```

---

## Implementation Strategy

### MVP First (User Stories 2 + 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 2 (Anonymizer)
4. Complete Phase 4: User Story 1 (First Upload)
5. **STOP and VALIDATE**: Run `pnpm dev login && pnpm dev upload --confirm` against local stack
6. Deploy/demo if ready — this is the minimum shippable CLI

### Incremental Delivery

1. Phases 1–4 → Working first upload (MVP)
2. Add Phase 5 (User Story 3) → Incremental uploads work → Demo/Deploy
3. Add Phase 6 (User Story 4) → Resumable uploads work → Demo/Deploy
4. Phase 7 → Polish, edge cases, SC-004 CI loop

### Parallel Team Strategy

With multiple developers, after Phase 2 completes:

- Developer A: User Story 2 (anonymizer rules T021–T026)
- Developer B: User Story 1 source modules (T027–T031) and auth flow (T032)
- Both reconvene for T033–T039 (commands + pipeline) once US2 and sources are ready

---

## Notes

- [P] tasks = different files, no intra-phase dependencies; safe to run concurrently
- [Story] label maps each task to the user story for traceability against spec.md
- Tests are included for the anonymizer (SC-001 is release-blocking) and ledger/classify (core business logic for incremental uploads); other tests in Phase 7 cover retry policy and version-gate contracts
- Each phase ends with a named checkpoint; verify that checkpoint before advancing
- The pre-commit gate (format + lint + typecheck + test) must pass before every commit; `--no-verify` is forbidden by constitution Principle V
- All exit codes must match contracts/exit-codes.md exactly; shell scripts and MCP wrappers depend on code stability (FR-037)

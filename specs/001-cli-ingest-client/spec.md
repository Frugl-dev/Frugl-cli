# Feature Specification: poppi-cli v1 — Public OSS Ingest Client

**Feature Branch**: `001-cli-ingest-client`

**Created**: 2026-05-23

**Status**: Draft

**Input**: User description: "poppi-cli — the public, open-source command-line client for hosted Poppi. Discovers local AI-coding session logs, anonymizes them client-side with a fail-closed policy, and uploads them to the user's isolated prefix in the hosted Poppi cloud."

## Overview

`poppi-cli` is the only ingest path into the hosted Poppi cloud product. It runs entirely on the developer's machine, discovers their AI-coding session logs, anonymizes them client-side, and uploads them to that developer's isolated storage prefix in the cloud. Without this CLI, the hosted dashboard has no data to render.

The CLI is the **trust gate** of the entire product: every byte of session data passes through its anonymizer before leaving the user's machine. Because the CLI is shipped as public, auditable open source, the entire privacy story of the product rests on this client being correct AND verifiable by outside parties.

A secondary downstream audience is a future MCP server (specified in the cloud product); the CLI's manifest JSON, redaction summary JSON, and exit codes MUST stay stable enough that an MCP wrapper can be added later without redesigning the CLI.

## Clarifications

### Session 2026-05-23

- Q: When `poppi upload` re-runs and the server returns "no such upload" (or equivalent) for the persisted upload identifier, what should the CLI do? → A: Discard stale local resume state, surface a clear notice to the user that the previous upload could not be resumed, and start a fresh manifest with the remaining on-disk sessions.
- Q: What progress output should `poppi upload` emit while it works? → A: Human-readable progress on stderr by default; opt-in NDJSON progress events on stdout via `--json` flag. Final manifest summary stays on stdout in both modes. Final-summary shape and NDJSON event shape are both public contracts (per FR-036).
- Q: When a presigned-URL PUT or cloud API call fails with a transient error, what should the CLI do? → A: Bounded exponential backoff (~3 attempts) for transient errors only (network reset, request timeout, HTTP 5xx, HTTP 429). Auth failures (401/403), version-gate (426), and other 4xx errors are never retried and fail fast.
- Q: What is the per-session upload concurrency strategy? → A: Small fixed default (target: 4 concurrent PUTs), exposed via a `--concurrency N` flag for user override. No adaptive scheme in v1.
- Q: On resume, when a session file referenced by the persisted manifest is no longer present on disk or has been modified since the first run, what should the CLI do? → A: Skip the missing/modified session with a stderr warning naming the affected file, complete the manifest with the actual reduced session count, and exit success.
- User directive (post-scan): Use a mature CLI framework rather than just an arg-parser. Crust was offered as a candidate but is Bun-native; the brief's Node ≥ 20 + `npm i -g poppi` + `npx poppi` constraints make Bun runtime infeasible without changing the distribution story. → Decision: **oclif**. Its plugin architecture also fits FR-007 (open extension point for future source adapters), and it is Node-native, mature, and widely audited.
- User directive (post-scan): Identify other places where mature OSS tooling can reduce hand-rolled surface area. → Decision: Lock the following at spec level as load-bearing foundation libraries (rationale and per-library mapping in Dependencies → Foundation libraries): **`zod`** (cloud-contract validation per FR-036/FR-040), **`semver`** (version-gate parsing per FR-032/FR-033), **`p-retry`** (bounded retry per FR-029a–d), **`p-limit`** (bounded concurrency per FR-025a), **`@inquirer/prompts`** (interactive login + upload-confirm per FR-001/FR-020), **`conf`** or equivalent (cross-platform resume-state persistence per FR-026/FR-027b). All other dependency choices remain deferred to `plan.md`.
- User directive (post-scan): Add a `--limit=N` flag to `poppi upload` so testers can upload only the first N discovered sessions without sending the whole batch. → Decision: Add as a user-visible upload-scoping flag (FR-006a, FR-020a). Applies to the pre-upload summary, dry-run inspection, and the actual upload identically — i.e., everything downstream of discovery sees the limited set as the canonical batch.
- User question (post-scan): When the user has already uploaded once and runs `poppi upload` again a week later, how does the CLI avoid re-uploading sessions that haven't changed, while still picking up new sessions AND in-place updates to existing sessions (Claude Code appends turns to a `.jsonl` over the life of a conversation)? → Decision: **Client-side local upload ledger** (Option A). The CLI persists, per `(endpoint, authenticated user)`, a small ledger of `{sessionId, contentHash, lastUploadedAt, manifestId}` for each session it has successfully uploaded. On each subsequent run, every discovered session is classified as `unchanged` (in ledger, hash matches → skipped), `updated` (in ledger, hash differs → re-uploaded under the same `sessionId`), or `new` (not in ledger → uploaded). `--limit N` applies AFTER classification, to the (new ∪ updated) subset. Session identity is derived from a stable per-source identifier (for Claude Code: the `sessionId` field already present in each JSONL line), not from a fresh random UUID per run — so the cloud sees a stable identity for the same on-disk session across uploads. Ledger loss (reinstall, new machine) is recoverable: the CLI treats all sessions as new and re-uploads; the cloud is expected to dedupe or version by `sessionId` on its side. The CLI does NOT ask the server "which sessions do you already have?" — that would either leak the local session list to the server (privacy regression) or require an extra round-trip. Local ledger is authority for the CLI; server is authority for the cloud.

## User Scenarios & Testing _(mandatory)_

### User Story 1 — First successful upload from a fresh install (Priority: P1)

A developer installs the CLI globally (or invokes it via the npm runner), runs `poppi login`, enters their email, pastes the 6-digit code they received, then runs `poppi upload`. The CLI lists the AI-coding sessions it found (count, date range, estimated payload size), asks for confirmation, anonymizes each session locally, uploads each as a discrete object to that user's isolated storage prefix, and exits successfully — printing a stable manifest identifier and a dashboard URL. For a typical batch (≤ 200 sessions / ≤ 200 MB compressed) the whole loop completes within 60 seconds on a stable broadband connection.

**Why this priority**: This is the entire reason the CLI exists. Without a working first-upload path, the cloud product has no data and the user has no reason to keep the CLI installed.

**Independent Test**: On a clean machine, with sample AI-coding session logs on disk and the cloud's local development stack running, `poppi login` followed by `poppi upload --confirm` (both pointed at the local stack) exits with success and the local dashboard renders the uploaded sessions under the authenticated user within 60 seconds.

**Acceptance Scenarios**:

1. **Given** a fresh install with no stored credentials and at least one discoverable session log on disk, **When** the user runs `poppi login`, supplies a valid email, and enters the correct one-time code, **Then** the CLI confirms login success and stores the auth token in the OS keychain (no plaintext file written to the home directory).
2. **Given** an authenticated user with discoverable session logs, **When** the user runs `poppi upload`, **Then** the CLI prints a pre-upload summary (session count, date range, estimated payload size, redaction policy version) and waits for confirmation before sending any bytes.
3. **Given** an authenticated user who has confirmed an upload, **When** the upload completes successfully, **Then** the CLI exits with success, prints a stable manifest identifier and a dashboard URL, and the cloud's dashboard reflects the uploaded sessions under that user's account.
4. **Given** an authenticated user who passes `--confirm` (or `--yes`), **When** they run `poppi upload --confirm`, **Then** the CLI skips the interactive prompt and proceeds directly to anonymization and upload.

---

### User Story 2 — Provable anonymization before any byte leaves the machine (Priority: P1)

A security-conscious developer wants to verify what the CLI will send before ever uploading for real. They run `poppi upload --dry-run --inspect`. The CLI processes every selected session through the anonymizer, writes the post-anonymization payload to a local inspection directory (default `./poppi-inspect/`), prints a per-session and per-category redaction summary, and transmits zero bytes to the network. The developer can diff the originals against the redacted output. For a canonical "planted secrets" fixture containing one secret per redaction category, 100% of planted values are absent from the inspection output.

**Why this priority**: This is the trust contract. Open source alone is not enough; users must be able to _run_ the verification themselves on their own data, on demand. If this loop is broken or unconvincing, the product loses credibility and the user has no reason to upload.

**Independent Test**: A fixture session containing one secret per category (Anthropic API key, OpenAI API key, AWS access key, GCP service-account key, GitHub token, Slack webhook URL, a `.env`-style assignment line, an absolute home path, a third-party email address that is not the authenticated user's, and a high-entropy unknown string of ≥ 20 characters and ≥ 4.5 bits/char) produces an inspection output in which a textual search for each planted value returns zero hits, and the printed summary records exactly one redaction in each category.

**Acceptance Scenarios**:

1. **Given** a fixture session containing one planted secret per supported redaction category, **When** the user runs `poppi upload --dry-run --inspect`, **Then** the inspection directory contains the redacted payload, the printed summary shows the expected counts per category, and no network request is made to any upload endpoint.
2. **Given** the authenticated user's own email address appears in a session, **When** anonymization runs, **Then** the user's own email is preserved as-is (so the user can recognize their own sessions) while any _other_ email addresses are replaced with stable per-upload pseudonyms.
3. **Given** a session containing repeated occurrences of the same project name or third-party email across multiple sessions in the batch, **When** anonymization runs, **Then** all occurrences within that single upload share one stable pseudonym (per-upload stable, not per-occurrence), so cross-session joins remain analytically useful while the real identifier is absent.
4. **Given** the anonymizer encounters a string it cannot confidently classify as safe (e.g., a high-entropy unknown value that falls in the configured fallback band), **When** processing that session, **Then** the value is redacted by default (fail-closed) rather than transmitted in the clear.
5. **Given** any successful upload or dry-run, **When** the manifest is generated, **Then** it includes an explicit `redaction_policy_version` string identifying the exact ruleset under which the redaction was performed.

---

### User Story 3 — Incremental upload over time (Priority: P1)

A developer uploaded everything once last week. Since then they've completed three new Claude Code sessions on disk and continued (appended turns to) two sessions that existed at the time of the previous upload. They run `poppi upload`. The CLI tells them: "Discovered 52 sessions: 47 unchanged (skipping), 3 new, 2 updated. Will upload 5 sessions." Only those 5 sessions are anonymized and transmitted. Existing-but-unchanged sessions are not re-anonymized, not re-uploaded, and not re-charged against the user's bandwidth.

**Why this priority**: After the very first upload, every subsequent `poppi upload` invocation is an incremental upload. If this case is not handled efficiently, the second use of the CLI re-uploads gigabytes of data the cloud already has, which destroys both the perf story (SC-003) and the user's trust. This is the _common_ path; first-upload is the _rare_ path.

**Independent Test**: After a successful initial upload of M sessions, add K new session files to disk and append additional turns to L of the original M files. Run `poppi upload` again. The CLI's pre-upload summary reports `M − L` unchanged, `K` new, `L` updated; the actual bytes transmitted equal the redacted payload size of the (K + L) sessions only; the cloud reports a total of `M + K` distinct session identifiers (because the L updated sessions reuse their original `sessionId`).

**Acceptance Scenarios**:

1. **Given** a user who has previously completed a successful upload (and therefore has a populated local ledger), **When** they run `poppi upload` with no new or modified sessions on disk, **Then** the CLI reports "No new or updated sessions to upload" and exits successfully without transmitting anything (matches FR-029).
2. **Given** the same user has K new sessions on disk since the last upload, **When** they run `poppi upload`, **Then** the pre-upload summary classifies discovered sessions into unchanged, new, and updated with explicit counts, and only the (new ∪ updated) set is anonymized and transmitted.
3. **Given** the same user has appended additional turns to an existing session file, **When** they run `poppi upload`, **Then** that session is classified as `updated`, re-uploaded under the same `sessionId` it had in the previous upload, and the cloud-side count of distinct sessions does not increase for that file.
4. **Given** the local ledger is missing or corrupted (user reinstalled their OS, or the state file was deleted), **When** they run `poppi upload`, **Then** the CLI surfaces a clear notice that the ledger is being rebuilt, classifies all discovered sessions as `new`, and uploads them. The cloud is expected to dedupe by `sessionId` on its side.
5. **Given** `--limit N` is passed alongside an incremental upload, **When** the CLI applies the limit, **Then** the limit is applied to the (new ∪ updated) subset AFTER classification — so `--limit 1` after the first upload uploads exactly one new-or-updated session, not zero and not one already-uploaded session.

---

### User Story 4 — Resumable upload after interruption (Priority: P1)

A developer's upload is interrupted mid-batch (network drop, Ctrl-C, laptop sleep). They re-run `poppi upload`. The CLI detects the in-flight upload and resumes from the next un-acknowledged session within the same manifest. It does not re-upload already-acknowledged objects, and the cloud server sees a single upload session rather than two competing ones.

**Why this priority**: Real session batches are large (hundreds of MB) and real networks are unreliable. A first-upload flow that cannot recover from interruption forces frustrated users to start over, wastes bandwidth, and creates duplicate-object cleanup work on the server. Without resumability, the product is brittle on the path that matters most (the very first upload).

**Independent Test**: Begin an upload of M sessions, then forcibly terminate the CLI after N of M sessions have been acknowledged by the server. Re-run `poppi upload`. The completion call reports exactly M sessions present, and the bytes sent during the second run equal the combined size of the remaining (M − N) sessions, not the full M.

**Acceptance Scenarios**:

1. **Given** an upload that was interrupted after N of M sessions had been acknowledged, **When** the user re-runs `poppi upload`, **Then** the CLI reuses the existing upload identifier (rather than creating a new one) and only transmits the remaining (M − N) sessions.
2. **Given** a resumed upload that completes successfully, **When** the CLI calls the upload-completion endpoint, **Then** the server reports exactly M sessions present and the CLI exits with success.
3. **Given** a re-run after a fully completed upload, **When** the user runs `poppi upload` again with no new sessions on disk, **Then** the CLI detects that nothing remains to send and exits successfully without uploading anything.

---

### Edge Cases

- **No sessions found**: The CLI prints a clear message naming the directory it searched, the source kind it expected, and exits with a documented non-zero exit code. No manifest is created.
- **Expired or revoked auth token**: The CLI surfaces an explicit authentication error, instructs the user to re-run `poppi login`, and exits with a documented non-zero exit code. The CLI never silently retries with stale credentials.
- **CLI version below server minimum**: When the server responds with the version-gate status code, the CLI prints a clear upgrade message (current version, required version, upgrade command) and exits with a documented non-zero exit code. No retry against any endpoint is attempted until the user upgrades.
- **Anonymization failure on a single session**: The entire batch aborts before any network transmission. The CLI never partially uploads a batch where one session could not be safely anonymized. The error names the offending session file and the rule that failed.
- **Keychain unavailable** (headless Linux without `libsecret`, locked keychain, etc.): The CLI surfaces a clear error explaining that secure token storage is required and exits with a documented non-zero exit code. The CLI never silently falls back to plaintext file storage.
- **Inspection directory already exists**: When `--inspect` is invoked and the target directory already exists, the CLI refuses to overwrite it without an explicit `--force` flag (or equivalent), so a previous inspection run cannot be silently clobbered.
- **Manifest endpoint succeeds but presign endpoint fails partway through**: The CLI surfaces the failure with a non-zero exit code and preserves enough local state that a subsequent re-run resumes the same upload identifier (per User Story 4).
- **Persisted resume state references an upload identifier the server no longer recognizes**: The CLI discards the stale resume state, prints a clear notice (naming the lost upload identifier), and starts a fresh manifest covering the remaining on-disk sessions. Treated as normal operation, not an error.
- **Session file referenced by the resume manifest is missing from disk on re-run**: The CLI skips that session with a stderr warning naming the file, continues with remaining un-acknowledged sessions, and completes the manifest with the actual reduced session count.
- **Session file content has changed since the first run** (hash mismatch against resume state): Treated identically to a missing file — skipped with a stderr warning, manifest completes with the reduced count. The CLI never uploads modified content under a session identifier that was anonymized from earlier content.
- **Local upload ledger missing or corrupted**: The CLI surfaces a clear stderr notice ("Upload ledger is being rebuilt"), classifies every discovered session as `new`, uploads everything, and rewrites the ledger as the cloud acknowledges sessions. Cloud-side dedup-by-`sessionId` prevents this from creating semantic duplicates; it just wastes bandwidth one time, which is acceptable.
- **Session file's native `sessionId` is missing or malformed** (corrupted Claude Code JSONL): The CLI MUST fall back to deriving a stable path-hash identifier (per FR-006b), record the derivation method in the manifest, and proceed. The fallback path MUST NOT cause the entire batch to abort.
- **`--limit N` against an incremental upload where the (new ∪ updated) count is zero**: The CLI MUST behave identically to FR-029 — report "No new or updated sessions to upload", ignore the `--limit` value entirely, and exit successfully.
- **Two different machines uploading the same logical session** (e.g., user has Claude Code on a laptop and a desktop, syncs `.claude/projects/` via cloud storage): Each machine has its own local ledger. The cloud receives the same `sessionId` from two clients and is expected to handle that (dedup or version on its side, per Dependencies). The CLI on each machine is unaware of the other and behaves correctly in isolation.
- **A new session log appears on disk between two `poppi upload` runs**: The newly appeared session is treated as outside the original manifest and either picked up by the next `poppi upload` invocation (after the current resume completes) or, on a fresh invocation, included in a new manifest.
- **User passes `--endpoint` pointing at an unreachable host**: The CLI surfaces a clear network error naming the endpoint and exits with a documented non-zero exit code; it does not attempt the default production endpoint as a fallback.
- **User's own email appears alongside third-party emails in the same line of output**: Only the user's own email is preserved; all others are pseudonymized, with no leakage across categories.

## Requirements _(mandatory)_

### Functional Requirements

#### Authentication

- **FR-001**: The CLI MUST support email + one-time-code login via `poppi login`, calling the cloud's documented OTP request and verify endpoints.
- **FR-002**: The CLI MUST support `poppi logout`, which both invalidates the session at the cloud and removes the locally stored token.
- **FR-003**: The CLI MUST support `poppi whoami`, which reports the currently authenticated identity (or a clear "not logged in" message and a non-zero exit code if no valid session exists).
- **FR-004**: The CLI MUST persist authentication tokens only in the operating system's secure credential store (macOS Keychain on macOS, Credential Manager on Windows, the system secret service on Linux). The CLI MUST NOT write tokens to plaintext files anywhere in the user's home directory or working directory.
- **FR-005**: When the secure credential store is unavailable on the current host, the CLI MUST surface a clear error and refuse to store credentials rather than silently falling back to insecure storage.

#### Session discovery

- **FR-006**: The CLI MUST discover Claude Code session logs at the documented Claude Code default location (`~/.claude/projects/**/*.jsonl`) as its v1 source.
- **FR-006a**: `poppi upload` MUST accept a `--limit N` flag (where N is a positive integer). When provided, the CLI MUST cap the **(new ∪ updated)** subset (i.e., after incremental classification per FR-006d) at the first N sessions in a deterministic order. The order MUST be stable across runs against the same on-disk set (the exact ordering criterion — e.g., file modification time descending, or file path lexicographic ascending — is locked in `plan.md`), so a tester running `--limit 1` twice in a row sees the same session both times unless the underlying session set has changed. The limited set is the canonical batch for all downstream steps: pre-upload summary, anonymization, dry-run inspection, upload, resume state, and manifest `expected_session_count`. The CLI MUST emit a clear notice when the flag is active, naming the limit, the total new+updated count it could have uploaded, and the total discovered count (e.g., "Limiting upload to 1 of 5 new/updated sessions (out of 52 discovered) per --limit").

#### Incremental upload (stable identity, ledger, classification)

- **FR-006b (stable session identity)**: For each discovered session, the CLI MUST derive a stable session identifier from the source file's content, NOT from a fresh random UUID per upload. For Claude Code JSONL sessions, the identifier MUST be the `sessionId` value already present in the session's JSONL records (Claude Code assigns this at session start and preserves it across appends). When a session file lacks a native stable identifier (future source types, or a malformed file), the CLI MUST derive one deterministically from stable file attributes (e.g., SHA-256 of the canonicalized absolute source path), recorded in the manifest as derivation-method = `"path-hash"` so the cloud can distinguish native IDs from derived ones. The same session file on the same machine MUST yield the same identifier across all `poppi upload` invocations and all CLI versions, so cross-upload identity is preserved.
- **FR-006c (local upload ledger)**: The CLI MUST persist a local upload ledger, keyed by `(endpoint URL, authenticated user ID)`, mapping each successfully uploaded `sessionId` to `{contentHash, lastUploadedAt, manifestId}` where `contentHash` is the SHA-256 of the _redacted_ payload that was actually uploaded. The ledger MUST live in the same OS-specific state directory as the resume state (per `conf` library conventions: XDG_STATE_HOME on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows). Ledger writes MUST be atomic so a process kill mid-write cannot corrupt the ledger.
- **FR-006d (classification)**: On each `poppi upload` invocation, after discovery, the CLI MUST classify every discovered session against the ledger as exactly one of:
  - **`unchanged`** — `sessionId` is in the ledger AND the _current_ redacted-content hash matches the ledger's `contentHash` → session MUST be skipped (not anonymized for upload, not transmitted, not included in the manifest).
  - **`updated`** — `sessionId` is in the ledger AND the current redacted-content hash differs from the ledger's `contentHash` → session MUST be uploaded under the SAME `sessionId` it had previously.
  - **`new`** — `sessionId` is not in the ledger → session MUST be uploaded.
    Classification ordering: discovery → classification → `--limit` truncation (FR-006a) → anonymization → upload.
- **FR-006e (ledger update on success)**: After the cloud acknowledges each uploaded session, the CLI MUST update the ledger entry for that `sessionId` with the new `contentHash`, `lastUploadedAt`, and `manifestId`. Ledger entries MUST NOT be written before the cloud has acknowledged the session, so a failed upload never leaves a misleading "already uploaded" record.
- **FR-006f (ledger loss recovery)**: If the local ledger is missing, corrupted, in an unrecognized schema version, or otherwise unreadable, the CLI MUST surface a clear stderr notice ("Upload ledger is being rebuilt"), proceed with all discovered sessions classified as `new`, and rewrite the ledger as uploads succeed. The CLI MUST NOT exit with a failure code on ledger loss; recovery is treated as normal operation. The cloud is responsible for deduplicating or versioning repeated uploads of the same `sessionId` on its side (see Dependencies).
- **FR-006g (privacy: ledger never leaves the machine)**: The CLI MUST NOT transmit ledger contents to any external party, including the cloud product. The CLI MUST NOT query the cloud for a list of already-uploaded session identifiers as a substitute for the local ledger.
- **FR-007**: The CLI MUST treat the set of session sources as an open extension point, structured so that additional sources (e.g., other AI coding assistants) can be added in subsequent releases without redesigning the discovery, anonymization, or upload pipeline.
- **FR-008**: For each discovered session, the CLI MUST record a `source_kind` identifier in the manifest so the server can route, parse, and version source-specific payloads independently.

#### Anonymization (the trust gate)

- **FR-009**: The CLI MUST run every byte of every session through the anonymizer before any network transmission. No session bytes may leave the machine unredacted, under any flag combination.
- **FR-010**: The anonymizer MUST apply a baseline secret-scanning ruleset covering at minimum: Anthropic API keys, OpenAI API keys, AWS access keys, Google Cloud service-account keys, GitHub tokens, Slack webhook URLs, and `.env`-style key-value assignments.
- **FR-011**: The anonymizer MUST apply a source-specific pass that, in v1 for Claude Code logs, redacts: absolute paths under the user's home directory (replaced with a `<HOME>` token), project/directory names (replaced with stable per-upload pseudonyms), and email addresses other than the authenticated user's own (replaced with stable per-upload pseudonyms).
- **FR-012**: The anonymizer MUST preserve the authenticated user's own email address as-is, so users can recognize their own sessions in the dashboard.
- **FR-013**: The anonymizer MUST apply a high-entropy fallback that flags and redacts strings of at least 20 characters whose per-character Shannon entropy is at least 4.5 bits, even when no specific rule matches.
- **FR-014**: The anonymizer MUST be **fail-closed**: when a value is plausibly sensitive but cannot be definitively classified, the value is redacted, not transmitted in the clear.
- **FR-015**: When anonymization fails for any session in the batch, the CLI MUST abort the entire batch before any network transmission and exit with a documented non-zero exit code naming the offending session and the failure category.
- **FR-016**: Pseudonyms generated for project names, third-party emails, and other category-based replacements MUST be stable across all sessions within a single upload (per-upload stable), but MUST NOT be stable across different uploads (so cross-upload linkage is impossible without server-side correlation).
- **FR-017**: Every manifest the CLI sends MUST carry a `redaction_policy_version` string identifying the exact ruleset version applied to the payload, so future audits can scope "all uploads made under policy version X."
- **FR-018**: The CLI MUST NOT emit any payload to the network when invoked with `--dry-run` (with or without `--inspect`), under any circumstances.
- **FR-019**: When invoked with `--dry-run --inspect`, the CLI MUST write the post-anonymization payload to a local inspection directory (default `./poppi-inspect/`, overridable via the same flag) and print a per-session, per-category redaction summary suitable for review and diffing.

#### Upload pipeline

- **FR-020**: Before sending any bytes, the CLI MUST present an interactive summary of what will be uploaded (session count, date range, estimated payload size, redaction policy version, destination endpoint) and require explicit user confirmation.
- **FR-020a**: When `--limit N` is in effect, the pre-upload summary MUST clearly indicate that the batch has been limited (e.g., "1 of 5 new/updated sessions (52 discovered total) selected via --limit") so the user does not believe they are uploading their entire discovered history.
- **FR-020b (incremental summary breakdown)**: When the local ledger contains any prior uploads for the current `(endpoint, user)`, the pre-upload summary MUST break the discovered set down into explicit counts: `discovered`, `unchanged (skipping)`, `new`, `updated`, `will-upload`. For example: "Discovered 52 sessions: 47 unchanged (skipping), 3 new, 2 updated. Will upload 5 sessions, ~22 MB redacted." For a fresh install (ledger empty), the breakdown collapses to the existing FR-020 summary (all discovered = all new).
- **FR-021**: The CLI MUST support `--confirm` (with `--yes` as an alias) to skip the interactive confirmation prompt for use in automation and CI.
- **FR-022**: The CLI MUST upload each session as a discrete object (one object per session) so that partial-batch resume is possible at session granularity.
- **FR-023**: The CLI MUST obtain a server-minted presigned upload URL for each session and PUT the anonymized payload directly to that URL, rather than streaming session bytes through the cloud's application servers.
- **FR-024**: The CLI MUST notify the cloud upon completion of the batch so the server can finalize the manifest, mark the upload complete, and surface it in the dashboard.
- **FR-025**: On success, the CLI MUST print a stable manifest identifier and a dashboard URL for the user to inspect their uploaded sessions, and exit with success.
- **FR-025a**: The CLI MUST upload sessions with a small bounded parallelism (default target: 4 concurrent PUTs), overridable via a `--concurrency N` flag (where N is a positive integer). The CLI MUST NOT implement adaptive concurrency in v1; the configured value is honored as-is.
- **FR-025b**: When concurrent PUTs are in flight, the CLI MUST persist per-session acknowledgment status as each PUT completes, so an interruption at any point yields a consistent resume state (per FR-026/FR-027) regardless of in-flight ordering.

#### Resumability

- **FR-026**: The CLI MUST persist enough local state during an in-progress upload (upload identifier, per-session acknowledgment status) to permit resuming from the next un-acknowledged session if the process is killed or the network drops.
- **FR-027**: When a previous upload is interrupted and the user re-runs `poppi upload`, the CLI MUST detect the in-flight state, reuse the existing upload identifier (rather than creating a new one), and transmit only the sessions that were not acknowledged in the previous run.
- **FR-027a**: When the cloud reports the persisted upload identifier is unknown or no longer valid (manifest expired, garbage-collected, or invalidated), the CLI MUST discard the stale local resume state, print a clear notice that the previous upload could not be resumed (naming the lost upload identifier), and start a fresh manifest covering the remaining on-disk sessions. The CLI MUST NOT exit with a failure code in this case; the recovered fresh-manifest path is treated as successful normal operation.
- **FR-027b**: On resume, for each un-acknowledged session in the persisted manifest, the CLI MUST verify that the session file is still present on disk and unchanged since the first run (e.g., via a content hash recorded in the resume state at first-run anonymization time). If a session is missing OR its content has changed, the CLI MUST skip that session, emit a clear stderr warning naming the file and the reason (missing vs. modified), and continue with the remaining un-acknowledged sessions. The completion call MUST report the actual final session count, not the original `expected_session_count`.
- **FR-027c**: Already-acknowledged sessions on resume are NOT re-verified against disk. Once a session has been acknowledged by the cloud, the CLI considers its contribution to the manifest complete, even if the source file is later deleted or modified.
- **FR-028**: When all sessions in a manifest have been successfully acknowledged, the CLI MUST call the cloud's completion endpoint exactly once and then clear the local resume state.
- **FR-029**: When the user re-runs `poppi upload` and the classification step (FR-006d) yields zero sessions in the (new ∪ updated) subset, the CLI MUST report "No new or updated sessions to upload" to the user and exit successfully without creating a manifest, calling the cloud, or transmitting anything.

#### Retry policy

- **FR-029a**: For transient request failures during upload — network reset, connection refused, request timeout, HTTP 5xx, and HTTP 429 — the CLI MUST retry the failing request with bounded exponential backoff (jittered), up to a small fixed number of attempts per request (target: 3 attempts total including the initial try). The exact backoff schedule is an implementation choice to be locked in `plan.md`.
- **FR-029b**: For non-transient request failures — HTTP 401/403 (auth), HTTP 426 (version gate), and all other HTTP 4xx not in FR-029a — the CLI MUST NOT retry. These surface immediately as their respective documented failure exit codes.
- **FR-029c**: When in-process retry is exhausted for a transient failure, the CLI MUST exit with the documented network-failure exit code, preserve local resume state, and emit a message instructing the user to re-run `poppi upload` (which will resume from the next un-acknowledged session per FR-027).
- **FR-029d**: Retry attempts MUST NOT issue duplicate cloud-side state-changing calls beyond the single failing request. A retried presign call is permitted (server-side presign endpoints are idempotent within an upload identifier); the CLI MUST NOT, for example, create a second manifest if the original manifest-creation call's response was lost mid-flight — it MUST instead surface a clear error and exit, so a re-run can resume cleanly.

#### Endpoint targeting and versioning

- **FR-030**: The CLI MUST accept an explicit `--endpoint` flag and a `POPPI_ENDPOINT` environment variable (flag wins on conflict) so the same binary can target a local development stack or the production cloud without recompilation.
- **FR-031**: When neither flag nor environment variable is provided, the CLI MUST default to the documented production endpoint.
- **FR-032**: Every request to the cloud MUST include a CLI-version header identifying the client release, so the server can enforce minimum-version policies.
- **FR-033**: When any cloud endpoint indicates the CLI is below the cloud's published minimum supported version (via the documented version-gate status code), the CLI MUST print a clear upgrade message (current version, required minimum, install/upgrade command) and exit with a documented non-zero exit code without retrying.

#### Privacy posture

- **FR-034**: The CLI MUST NOT emit telemetry, usage analytics, crash reports, or any other unsolicited network traffic. Every network request the CLI makes MUST be a direct, traceable consequence of a user-invoked command.
- **FR-035**: The CLI MUST NOT include any auto-update mechanism that contacts a remote server on its own schedule; version checking happens only as a side effect of cloud calls the user has explicitly invoked.

#### Output stability (for downstream MCP wrapping)

- **FR-036**: The shape of the manifest JSON payload (field names, types, nesting), the redaction summary JSON, the NDJSON progress event shape (per FR-038), the final manifest-summary JSON written to stdout on success, and the documented exit codes are all public contracts. Any change that is not strictly additive constitutes a breaking change and MUST follow the cross-repo coordinated-bump process described under Dependencies.
- **FR-037**: Every documented failure mode MUST map to a distinct, stable, grep-able exit code (auth failure, anonymization failure, version-gate failure, network failure, no-sessions-found, keychain-unavailable, etc.) so scripts and the eventual MCP wrapper can branch on outcome without parsing prose.
- **FR-038**: By default, `poppi upload` MUST emit human-readable progress (per-session status, counts, errors) on stderr and reserve stdout for the final manifest-summary JSON printed on success. Progress output on stderr is NOT a stable contract and may be reformatted between releases.
- **FR-039**: When invoked with `--json`, `poppi upload` MUST emit one structured progress event per line (NDJSON) on stdout — covering at minimum: upload-start, per-session-start, per-session-acked, per-session-failed, upload-complete — followed by the final manifest-summary JSON as the last line on stdout. Each event MUST carry a stable event-type discriminator and a monotonic sequence number. Stderr in `--json` mode MUST be reserved for diagnostics and warnings only.
- **FR-040**: When invoked with `--json`, all other CLI commands (`login`, `logout`, `whoami`) MUST emit a single structured JSON object on stdout for the command result and reserve stderr for diagnostics, so the eventual MCP wrapper has a uniform parsing contract across the CLI surface.

### Commands (v1 surface)

- **`poppi login`** — Email + OTP login. Persists token to OS keychain.
- **`poppi logout`** — Invalidates session at cloud and removes local token.
- **`poppi whoami`** — Reports the currently authenticated identity.
- **`poppi upload`** — Discovers, anonymizes, and uploads sessions. Flags: `--dry-run`, `--inspect [dir]`, `--confirm`/`--yes`, `--endpoint <url>`, `--json` (machine-readable NDJSON progress on stdout), `--concurrency N` (per-session upload parallelism; default 4), `--limit N` (testing aid: upload only the first N discovered sessions; deterministic ordering, summary clearly marks the limit).
- **`poppi --version`** — Prints the CLI version.
- **`poppi --help`** — Prints command and flag documentation.

### Key Entities

- **Authenticated user**: A real human identified by email address, authenticated via the cloud's OTP flow. Owns an isolated storage prefix in the cloud. Their own email is the one identifier the CLI deliberately does NOT pseudonymize, so they can recognize their own sessions.
- **Session log**: A single source-specific file representing one AI-coding session on the user's machine. In v1, this is a Claude Code `.jsonl` file under `~/.claude/projects/`. The file is the unit of discovery, anonymization, upload, and resume.
- **Manifest**: A server-side record describing one upload batch. Created via the manifest endpoint, finalized via the completion endpoint. Carries `cli_version`, `redaction_policy_version`, `source_kind`, `expected_session_count`, and per-session entries with CLI-generated identifiers. Stable across resume; one manifest may receive multiple `poppi upload` invocations until it is completed.
- **Redacted payload**: The anonymized form of a session log, produced locally before upload. Exists only on disk (when `--inspect` is used) or in memory during transmission.
- **Local resume state**: A small on-disk record of the in-flight upload identifier and per-session acknowledgment status, used to make `poppi upload` re-runs idempotent after interruption.
- **Upload ledger**: A persisted local record of every session ever successfully uploaded under a given `(endpoint, authenticated user)`, mapping stable `sessionId` to `{contentHash, lastUploadedAt, manifestId}`. Source of truth for "is this session already uploaded, and is the on-disk version still current?" Never transmitted off the machine; can be rebuilt by re-uploading (cloud is expected to dedupe by `sessionId`).
- **Session classification**: A per-discovered-session label of `unchanged`, `new`, or `updated`, computed by comparing each discovered session against the upload ledger. Drives the pre-upload summary breakdown and determines which sessions enter the batch.
- **Redaction summary**: A per-session, per-category count of redactions applied during anonymization. Emitted to stdout during `--dry-run --inspect` and (optionally) written alongside the inspection payload for review.
- **Endpoint**: A target cloud instance, identified by URL. May be the production cloud or any compatible development instance. Selected per-invocation via flag or environment variable.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001 (Anonymization correctness)**: For a canonical "planted secrets" fixture containing one secret per supported redaction category, 100% of planted values are absent from the post-anonymization output, verified by automated assertions in continuous integration. Any regression that admits even one planted value blocks the release.
- **SC-002 (Trust gate is usable)**: A new user can audit what would be uploaded by running the dry-run inspection command and reach an informed go/no-go decision for a typical month of session logs in under 5 minutes, without reading source code.
- **SC-003 (First-upload round-trip)**: For a typical first-time upload of ≤ 200 sessions / ≤ 200 MB compressed against a properly provisioned cloud endpoint on a stable broadband connection, the entire `poppi upload --confirm` invocation completes in under 60 seconds wall-clock.
- **SC-003a (Incremental upload is cheap)**: For a follow-up `poppi upload --confirm` invocation where the discovered set contains exactly K new or updated sessions out of M total (K ≤ M), wall-clock time and bytes-transmitted MUST scale with K and not M. Concretely: discovering, hashing, and classifying M sessions to identify the K to upload MUST complete in under 5 seconds on a typical developer laptop for M = 1000 sessions on disk. Once classified, transmission time is governed by SC-003 applied to the K-session subset.
- **SC-004 (Local parity)**: The full login → discover → anonymize → upload → dashboard-visible loop works end-to-end against the cloud product's local development stack with zero external credentials and zero internet access. The same loop is exercised in continuous integration.
- **SC-005 (Resumability)**: After arbitrary mid-batch interruption (network drop, Ctrl-C, process kill), a single subsequent `poppi upload` invocation completes the upload with zero duplicate object PUTs and a single server-side upload identifier across both runs.
- **SC-006 (Honest failures)**: Every documented failure scenario (auth, anonymization, version gate, network, no-sessions, keychain-unavailable) exits with a distinct, documented, non-zero exit code and a human-readable error message naming the failure category. No failure mode silently degrades to a partial success.
- **SC-007 (No silent network)**: Over any 24-hour period in which the user does not invoke a poppi command, the installed CLI makes zero network requests.

## Dependencies

This CLI is one half of a two-repository product. The other half is the hosted Poppi cloud (sibling repo `poppi/`, spec `001-cloud-ingest-platform`). The cloud's HTTP contracts are consumed verbatim by this CLI; schema-incompatible changes on either side require a coordinated release across both repos. The negotiation surface between the two is the CLI's published _minimum supported cloud server version_ and the cloud's published _minimum supported CLI version_.

Specifically, the CLI consumes the cloud's documented authentication endpoints (OTP request, OTP verify, sign-out, whoami) and upload endpoints (manifest creation, per-session presigning, completion, listing, retrieval).

### Cross-repo expectations on the cloud

The CLI's incremental-upload design (FR-006b–g) depends on the following cloud-side guarantees, which must be honored by the cloud product (sibling spec `001-cloud-ingest-platform`) for the CLI to behave correctly. These are recorded here so the cross-repo coordinated-bump process catches divergence:

- The cloud MUST accept repeated uploads of the same `sessionId` within a single authenticated account, across different upload manifests, and deduplicate or version them on its side (latest-write-wins or explicit versioning — the choice is the cloud's). Re-uploading the same `sessionId` MUST NOT produce semantic duplicates in the dashboard.
- The cloud MUST surface a stable `sessionId` field in the manifest schema (already required by the brief's manifest payload field list).
- The cloud's session storage MUST tolerate a manifest's per-session entry referring to an identifier that has been seen in a previous manifest for the same user.

If the cloud changes any of these guarantees, the CLI's incremental story breaks; a coordinated bump is required.

### Framework & runtime constraints

- **Runtime**: Node.js ≥ 20 (per the brief's Constitution V tech-stack choice). The CLI MUST run on the Node runtime shipped with `npm i -g poppi` and `npx poppi`; it MUST NOT require users to install a non-default JavaScript runtime.
- **CLI framework**: oclif. Reasons: Node-native (compatible with the npm distribution model above), mature plugin architecture (clean fit for FR-007's open extension point for future source adapters), mature help/version/error subsystems (reduce surface area we have to maintain ourselves), and broadly audited (consistent with the OSS trust posture). The plan phase locks the major version.

### Foundation libraries (load-bearing — locked at spec level)

The following libraries are named in the spec (rather than deferred to `plan.md`) because each is load-bearing for a specific functional requirement, and swapping it later would reshape testing strategy, the cross-repo contract surface, or the cross-platform behavior promised in success criteria. The plan phase locks major versions and any configuration shape; substitution requires an amended spec.

- **`zod`** — runtime validation of cloud HTTP responses (manifest creation, presign, completion, whoami) and source-of-truth for the TypeScript types of those payloads. Locked because FR-036 makes the manifest JSON, redaction summary JSON, NDJSON event shape, and final-summary JSON public contracts; runtime validation catches contract drift between this repo and the cloud (`poppi/`) at the moment a response arrives, not three callsites later. Same library MUST be used to derive the input types for the per-command structured outputs in FR-040.
- **`semver`** — parses and compares CLI vs. server version strings. Locked because FR-032/FR-033 require the CLI to read the cloud's published minimum-supported-CLI version from the 426 response body and decide whether to exit with the version-gate failure code; hand-rolled string-compare logic is a known anti-pattern with real bugs (pre-release ordering, build metadata, range semantics).
- **`p-retry`** — bounded exponential backoff with jitter for transient HTTP failures. Locked because FR-029a–d define the retry surface explicitly (transient errors only — network reset, 5xx, 429, timeout — capped at ~3 attempts, never retrying auth/version-gate/4xx-other), and `p-retry`'s predicate-based "retry only if this error matches" API is a clean fit. Centralizes a behavior that, hand-rolled per call-site, accumulates bugs.
- **`p-limit`** — bounded concurrency primitive for the per-session upload parallelism in FR-025a. Locked because the `--concurrency N` flag's behavior must be exact and predictable (not adaptive, no surprise queueing), and a custom worker-pool would re-derive a well-trodden ~30-line library without the surrounding test coverage `p-limit` already has.
- **`@inquirer/prompts`** — interactive prompts for `poppi login` (email + masked one-time-code entry) and the FR-020 upload confirmation. Locked because TTY-aware input with masked entry has real cross-platform edge cases (raw mode, signal handling on Ctrl-C, paste handling for the 6-digit code) that are not the kind of thing a security-sensitive client should be inventing from scratch.
- **`conf`** (or equivalent `env-paths`-based wrapper) — on-disk persistence of the local resume state (FR-026, FR-027b session hashes) at the correct OS-specific location (XDG_STATE_HOME on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows). Locked because FR-027/027a/027b/027c require the resume mechanism to behave consistently across the three target platforms, and the right state-dir-per-OS logic is exactly the kind of cross-platform footgun a CLI should not hand-roll.

All other libraries (HTTP client, glob walker, hashing, UUID, JSON.parse, progress bar, color output, gzip, etc.) are implementation choices deferred to `plan.md`, preferring Node built-ins where possible.

## Assumptions

- The cloud product's `001-cloud-ingest-platform` is in place and stable enough to depend on. Its local development stack (with managed-auth and object-storage substitutes) is the canonical development and CI target; production poppi.app becomes the default endpoint once the cloud deploy spec lands.
- The CLI is published as public open source from day one. Every commit is publishable; no proprietary code paths or build-time secrets exist.
- v1 supports exactly one source kind (Claude Code session logs at the documented path). Additional sources (other AI coding assistants) are deferred to follow-up specs, but the architecture must not foreclose them.
- Users have reasonable broadband connectivity for the first-upload performance target. Slower connections still work; they just take longer than the 60-second target.
- A secure OS credential store is available on the user's machine. Users on minimal environments without a credential store are out of scope for v1; the CLI surfaces a clear error rather than degrading to plaintext storage.
- The cloud's auth, upload, and version-gate contracts are stable enough to depend on; any breaking change requires a coordinated bump across both repos using the published minimum-version handshake.
- Account deletion (`poppi delete --upload <id>`, `poppi delete --account`) is **deferred** to follow-up spec `002-delete`, blocked on the cloud's deletion endpoints.
- OAuth provider sign-in (Google, GitHub, etc.) is **deferred** to follow-up spec `003-oauth`, blocked on cloud's OAuth provider spec.
- Additional source adapters (Cursor, Gemini, Codex, Aider, etc.) are **deferred** to follow-up spec `004-sources`. Each new source is one follow-up spec with its own source-specific redaction pass.
- IDE plugins, in-editor cost meters, and real-time/streaming uploads are out of scope for v1.
- Telemetry of any kind is out of scope for v1 and is not anticipated for any future version; the CLI is explicitly designed to emit nothing the user did not explicitly invoke.

# Feature Specification: poppi-cli v1 — Public OSS Ingest Client

**Feature Branch**: `001-cli-ingest-client`

**Created**: 2026-05-23

**Status**: Draft

**Input**: User description: "poppi-cli — the public, open-source command-line client for hosted Poppi. Discovers local AI-coding session logs, anonymizes them client-side with a fail-closed policy, and uploads them to the user's isolated prefix in the hosted Poppi cloud."

## Overview

`poppi-cli` is the only ingest path into the hosted Poppi cloud product. It runs entirely on the developer's machine, discovers their AI-coding session logs, anonymizes them client-side, and uploads them to that developer's isolated storage prefix in the cloud. Without this CLI, the hosted dashboard has no data to render.

The CLI is the **trust gate** of the entire product: every byte of session data passes through its anonymizer before leaving the user's machine. Because the CLI is shipped as public, auditable open source, the entire privacy story of the product rests on this client being correct AND verifiable by outside parties.

A secondary downstream audience is a future MCP server (specified in the cloud product); the CLI's manifest JSON, redaction summary JSON, and exit codes MUST stay stable enough that an MCP wrapper can be added later without redesigning the CLI.

## User Scenarios & Testing *(mandatory)*

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

**Why this priority**: This is the trust contract. Open source alone is not enough; users must be able to *run* the verification themselves on their own data, on demand. If this loop is broken or unconvincing, the product loses credibility and the user has no reason to upload.

**Independent Test**: A fixture session containing one secret per category (Anthropic API key, OpenAI API key, AWS access key, GCP service-account key, GitHub token, Slack webhook URL, a `.env`-style assignment line, an absolute home path, a third-party email address that is not the authenticated user's, and a high-entropy unknown string of ≥ 20 characters and ≥ 4.5 bits/char) produces an inspection output in which a textual search for each planted value returns zero hits, and the printed summary records exactly one redaction in each category.

**Acceptance Scenarios**:

1. **Given** a fixture session containing one planted secret per supported redaction category, **When** the user runs `poppi upload --dry-run --inspect`, **Then** the inspection directory contains the redacted payload, the printed summary shows the expected counts per category, and no network request is made to any upload endpoint.
2. **Given** the authenticated user's own email address appears in a session, **When** anonymization runs, **Then** the user's own email is preserved as-is (so the user can recognize their own sessions) while any *other* email addresses are replaced with stable per-upload pseudonyms.
3. **Given** a session containing repeated occurrences of the same project name or third-party email across multiple sessions in the batch, **When** anonymization runs, **Then** all occurrences within that single upload share one stable pseudonym (per-upload stable, not per-occurrence), so cross-session joins remain analytically useful while the real identifier is absent.
4. **Given** the anonymizer encounters a string it cannot confidently classify as safe (e.g., a high-entropy unknown value that falls in the configured fallback band), **When** processing that session, **Then** the value is redacted by default (fail-closed) rather than transmitted in the clear.
5. **Given** any successful upload or dry-run, **When** the manifest is generated, **Then** it includes an explicit `redaction_policy_version` string identifying the exact ruleset under which the redaction was performed.

---

### User Story 3 — Resumable upload after interruption (Priority: P1)

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
- **Manifest endpoint succeeds but presign endpoint fails partway through**: The CLI surfaces the failure with a non-zero exit code and preserves enough local state that a subsequent re-run resumes the same upload identifier (per User Story 3).
- **A new session log appears on disk between two `poppi upload` runs**: The newly appeared session is treated as outside the original manifest and either picked up by the next `poppi upload` invocation (after the current resume completes) or, on a fresh invocation, included in a new manifest.
- **User passes `--endpoint` pointing at an unreachable host**: The CLI surfaces a clear network error naming the endpoint and exits with a documented non-zero exit code; it does not attempt the default production endpoint as a fallback.
- **User's own email appears alongside third-party emails in the same line of output**: Only the user's own email is preserved; all others are pseudonymized, with no leakage across categories.

## Requirements *(mandatory)*

### Functional Requirements

#### Authentication

- **FR-001**: The CLI MUST support email + one-time-code login via `poppi login`, calling the cloud's documented OTP request and verify endpoints.
- **FR-002**: The CLI MUST support `poppi logout`, which both invalidates the session at the cloud and removes the locally stored token.
- **FR-003**: The CLI MUST support `poppi whoami`, which reports the currently authenticated identity (or a clear "not logged in" message and a non-zero exit code if no valid session exists).
- **FR-004**: The CLI MUST persist authentication tokens only in the operating system's secure credential store (macOS Keychain on macOS, Credential Manager on Windows, the system secret service on Linux). The CLI MUST NOT write tokens to plaintext files anywhere in the user's home directory or working directory.
- **FR-005**: When the secure credential store is unavailable on the current host, the CLI MUST surface a clear error and refuse to store credentials rather than silently falling back to insecure storage.

#### Session discovery

- **FR-006**: The CLI MUST discover Claude Code session logs at the documented Claude Code default location (`~/.claude/projects/**/*.jsonl`) as its v1 source.
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
- **FR-021**: The CLI MUST support `--confirm` (with `--yes` as an alias) to skip the interactive confirmation prompt for use in automation and CI.
- **FR-022**: The CLI MUST upload each session as a discrete object (one object per session) so that partial-batch resume is possible at session granularity.
- **FR-023**: The CLI MUST obtain a server-minted presigned upload URL for each session and PUT the anonymized payload directly to that URL, rather than streaming session bytes through the cloud's application servers.
- **FR-024**: The CLI MUST notify the cloud upon completion of the batch so the server can finalize the manifest, mark the upload complete, and surface it in the dashboard.
- **FR-025**: On success, the CLI MUST print a stable manifest identifier and a dashboard URL for the user to inspect their uploaded sessions, and exit with success.

#### Resumability

- **FR-026**: The CLI MUST persist enough local state during an in-progress upload (upload identifier, per-session acknowledgment status) to permit resuming from the next un-acknowledged session if the process is killed or the network drops.
- **FR-027**: When a previous upload is interrupted and the user re-runs `poppi upload`, the CLI MUST detect the in-flight state, reuse the existing upload identifier (rather than creating a new one), and transmit only the sessions that were not acknowledged in the previous run.
- **FR-028**: When all sessions in a manifest have been successfully acknowledged, the CLI MUST call the cloud's completion endpoint exactly once and then clear the local resume state.
- **FR-029**: When the user re-runs `poppi upload` after a fully completed upload, the CLI MUST detect that nothing remains to send (no new sessions, no stale resume state) and exit successfully without transmitting anything.

#### Endpoint targeting and versioning

- **FR-030**: The CLI MUST accept an explicit `--endpoint` flag and a `POPPI_ENDPOINT` environment variable (flag wins on conflict) so the same binary can target a local development stack or the production cloud without recompilation.
- **FR-031**: When neither flag nor environment variable is provided, the CLI MUST default to the documented production endpoint.
- **FR-032**: Every request to the cloud MUST include a CLI-version header identifying the client release, so the server can enforce minimum-version policies.
- **FR-033**: When any cloud endpoint indicates the CLI is below the cloud's published minimum supported version (via the documented version-gate status code), the CLI MUST print a clear upgrade message (current version, required minimum, install/upgrade command) and exit with a documented non-zero exit code without retrying.

#### Privacy posture

- **FR-034**: The CLI MUST NOT emit telemetry, usage analytics, crash reports, or any other unsolicited network traffic. Every network request the CLI makes MUST be a direct, traceable consequence of a user-invoked command.
- **FR-035**: The CLI MUST NOT include any auto-update mechanism that contacts a remote server on its own schedule; version checking happens only as a side effect of cloud calls the user has explicitly invoked.

#### Output stability (for downstream MCP wrapping)

- **FR-036**: The shape of the manifest JSON payload (field names, types, nesting), the redaction summary JSON, and the documented exit codes are public contracts. Any change that is not strictly additive constitutes a breaking change and MUST follow the cross-repo coordinated-bump process described under Dependencies.
- **FR-037**: Every documented failure mode MUST map to a distinct, stable, grep-able exit code (auth failure, anonymization failure, version-gate failure, network failure, no-sessions-found, keychain-unavailable, etc.) so scripts and the eventual MCP wrapper can branch on outcome without parsing prose.

### Commands (v1 surface)

- **`poppi login`** — Email + OTP login. Persists token to OS keychain.
- **`poppi logout`** — Invalidates session at cloud and removes local token.
- **`poppi whoami`** — Reports the currently authenticated identity.
- **`poppi upload`** — Discovers, anonymizes, and uploads sessions. Flags: `--dry-run`, `--inspect [dir]`, `--confirm`/`--yes`, `--endpoint <url>`.
- **`poppi --version`** — Prints the CLI version.
- **`poppi --help`** — Prints command and flag documentation.

### Key Entities

- **Authenticated user**: A real human identified by email address, authenticated via the cloud's OTP flow. Owns an isolated storage prefix in the cloud. Their own email is the one identifier the CLI deliberately does NOT pseudonymize, so they can recognize their own sessions.
- **Session log**: A single source-specific file representing one AI-coding session on the user's machine. In v1, this is a Claude Code `.jsonl` file under `~/.claude/projects/`. The file is the unit of discovery, anonymization, upload, and resume.
- **Manifest**: A server-side record describing one upload batch. Created via the manifest endpoint, finalized via the completion endpoint. Carries `cli_version`, `redaction_policy_version`, `source_kind`, `expected_session_count`, and per-session entries with CLI-generated identifiers. Stable across resume; one manifest may receive multiple `poppi upload` invocations until it is completed.
- **Redacted payload**: The anonymized form of a session log, produced locally before upload. Exists only on disk (when `--inspect` is used) or in memory during transmission.
- **Local resume state**: A small on-disk record of the in-flight upload identifier and per-session acknowledgment status, used to make `poppi upload` re-runs idempotent after interruption.
- **Redaction summary**: A per-session, per-category count of redactions applied during anonymization. Emitted to stdout during `--dry-run --inspect` and (optionally) written alongside the inspection payload for review.
- **Endpoint**: A target cloud instance, identified by URL. May be the production cloud or any compatible development instance. Selected per-invocation via flag or environment variable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 (Anonymization correctness)**: For a canonical "planted secrets" fixture containing one secret per supported redaction category, 100% of planted values are absent from the post-anonymization output, verified by automated assertions in continuous integration. Any regression that admits even one planted value blocks the release.
- **SC-002 (Trust gate is usable)**: A new user can audit what would be uploaded by running the dry-run inspection command and reach an informed go/no-go decision for a typical month of session logs in under 5 minutes, without reading source code.
- **SC-003 (First-upload round-trip)**: For a typical first-time upload of ≤ 200 sessions / ≤ 200 MB compressed against a properly provisioned cloud endpoint on a stable broadband connection, the entire `poppi upload --confirm` invocation completes in under 60 seconds wall-clock.
- **SC-004 (Local parity)**: The full login → discover → anonymize → upload → dashboard-visible loop works end-to-end against the cloud product's local development stack with zero external credentials and zero internet access. The same loop is exercised in continuous integration.
- **SC-005 (Resumability)**: After arbitrary mid-batch interruption (network drop, Ctrl-C, process kill), a single subsequent `poppi upload` invocation completes the upload with zero duplicate object PUTs and a single server-side upload identifier across both runs.
- **SC-006 (Honest failures)**: Every documented failure scenario (auth, anonymization, version gate, network, no-sessions, keychain-unavailable) exits with a distinct, documented, non-zero exit code and a human-readable error message naming the failure category. No failure mode silently degrades to a partial success.
- **SC-007 (No silent network)**: Over any 24-hour period in which the user does not invoke a poppi command, the installed CLI makes zero network requests.

## Dependencies

This CLI is one half of a two-repository product. The other half is the hosted Poppi cloud (sibling repo `poppi/`, spec `001-cloud-ingest-platform`). The cloud's HTTP contracts are consumed verbatim by this CLI; schema-incompatible changes on either side require a coordinated release across both repos. The negotiation surface between the two is the CLI's published *minimum supported cloud server version* and the cloud's published *minimum supported CLI version*.

Specifically, the CLI consumes the cloud's documented authentication endpoints (OTP request, OTP verify, sign-out, whoami) and upload endpoints (manifest creation, per-session presigning, completion, listing, retrieval).

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

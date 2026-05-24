# Feature Specification: poppi-cli PR-link metadata — opt-in per-session git context at upload time

**Feature Branch**: `005-cli-pr-metadata`

**Created**: 2026-05-24

**Status**: Draft

**Input**: User description: "Capture and attach per-session git metadata (repository identity, branch, commit) to the upload manifest so the cloud can link uploaded sessions to the pull requests they contributed to — the CLI-side half of the cloud's PR-linking / merge-rate feature. Privacy-first: off by default, auditable before send, and never transmits anything the user did not explicitly opt into."

## Cross-repo context _(informational)_

This spec is the **producer side** of the cloud feature [`poppi/specs/005-intelligence-post-processing/spec.md`](../../../poppi/specs/005-intelligence-post-processing/spec.md), specifically its GitHub / pull-request story (US5) and FR-024:

> **FR-024** (cloud 005): "The system MUST link sessions to pull requests using metadata supplied **at upload time by the CLI** (e.g. branch, commit SHA, or explicit PR reference); it MUST NOT parse session content to infer PR associations."

The cloud spec records the producer contract as a dependency owned by this repo:

> (cloud 005 Assumptions) "PR linking depends on the CLI attaching PR/branch/commit metadata at upload time; **defining that CLI metadata contract is a dependency tracked in the `poppi-cli/` repo, consumed here.**"

This spec **defines** that contract. The cloud stores the association as an additive `pr_id` reserved key in `parsed_artifacts.summary` (cloud 005 Assumptions) and computes org merge rate from sessions linked to merged vs. closed-without-merge PRs (cloud FR-028). A session that carries **no** PR-linking metadata simply never appears in a PR's linked-session list and is excluded from the merge-rate denominator (cloud 005 Edge Cases) — so the metadata is, by design, **optional and best-effort per session**.

The cloud-side consumer (GitHub OAuth connection, PR matching, merge-rate computation) is itself deferred on the cloud roadmap (cloud 005 US5 is P2; the matching engine lands in a later cloud plan). This CLI feature ships the **producer** side as forward-compatible groundwork: once a user connects GitHub on the dashboard, sessions already uploaded with git context become linkable with no further CLI action. Until then, the attached metadata is stored and unused — harmless.

### Why this is a deliberate privacy decision (the crux)

The CLI's existing anonymizer (`001-cli-ingest-client` FR-011) **redacts** absolute home paths, project/directory names, and third-party identifiers, replacing them with `<HOME>` tokens and per-upload pseudonyms. A git repository's identity — its remote host and `owner/name` (e.g. `github.com` + `acme/widgets`) — and its branch names are **exactly that class of identifying data**, and branch names frequently embed ticket IDs, customer names, or feature codenames.

Therefore, attaching real repository coordinates so the cloud can match a real GitHub PR is a **deliberate departure** from the default fail-closed redaction policy. It MUST be:

1. **Opt-in** — never on by default; no behaviour change for users who do not enable it.
2. **Auditable before send** — the exact metadata that will leave the machine MUST be visible in the pre-upload summary and in the `--dry-run --inspect` output, so the trust contract (`001` User Story 2) still holds.
3. **Credential-safe** — remote URLs containing embedded credentials MUST be stripped to host + `owner/name` before anything is recorded or sent.

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Opt in to link uploaded sessions to their pull requests (Priority: P1)

A developer wants their team's dashboard to show how much AI spend went into each shipped PR. They run `poppi upload --link-prs`. For each session in the upload batch, the CLI determines the git repository the session was worked in (from the session's recorded working directory), reads the repository's remote identity, branch, and current commit — read-only — and attaches that git context to the session's manifest entry. The pre-upload summary shows which repositories and how many sessions will carry git context. After upload, once the team connects GitHub on the dashboard, those sessions become linkable to their pull requests.

**Why this priority**: This is the entire reason the feature exists — it is the CLI half of the cloud's headline "did this AI spend ship as a merged PR?" waste lever (cloud 005 US5 / FR-028). Without the CLI attaching the metadata, the cloud's merge-rate and cost-to-merge surfaces have nothing to join on.

**Independent Test**: With a sample session whose recorded working directory is a clean git checkout of a repo with a GitHub `origin` remote on a feature branch, running `poppi upload --link-prs` against the local stack produces a manifest in which that session's entry carries git context with the correct repository `owner/name`, branch, and a 40-hex commit SHA. A session uploaded **without** `--link-prs` carries no git context.

**Acceptance Scenarios**:

1. **Given** `--link-prs` is set and a session whose working directory resolves to a git repository with a remote, **When** `poppi upload` runs, **Then** that session's manifest entry includes a git-context object with the repository identity (host + `owner/name`), the branch, and the current commit SHA.
2. **Given** `--link-prs` is set, **When** the pre-upload summary renders, **Then** it states how many of the to-be-uploaded sessions will carry git context and names the distinct repositories involved (e.g., "Git context: 4 of 5 sessions, repos: acme/widgets, acme/api").
3. **Given** a repository `origin` remote URL that embeds credentials (e.g. a token in `https://x-access-token:TOKEN@github.com/acme/widgets.git`), **When** the CLI records the repository identity, **Then** the recorded value contains only host + `owner/name` — the credentials/token are stripped and never recorded, summarised, inspected, or transmitted.
4. **Given** the role/identity context is unchanged, **When** git context is attached, **Then** it is attached as manifest metadata alongside (not inside) the anonymized session payload, so it does not alter the redacted-payload content hash the incremental ledger keys on.

---

### User Story 2 — Default is off: nothing git-related leaves the machine unless explicitly enabled (Priority: P1)

A privacy-conscious developer runs `poppi upload` as usual, without any new flag. The CLI behaves exactly as it does today: it discovers, anonymizes, and uploads sessions, and transmits **zero** git/repository/branch/commit metadata. If they look at the pre-upload summary, it confirms that PR linking is off.

**Why this priority**: This feature intentionally transmits identifying repository data that the anonymizer otherwise redacts. The only way that is acceptable in a trust-gate product is if it is strictly opt-in and the default path is provably unchanged. If a user could leak repo identity without asking for it, the product's privacy story breaks.

**Independent Test**: Running `poppi upload` (no `--link-prs`) against a mock server that records every request body shows that no manifest entry contains any git-context field, and no repository remote was read from disk (verified by pointing the working directory at a git repo and asserting the metadata is still absent).

**Acceptance Scenarios**:

1. **Given** `--link-prs` is NOT set, **When** `poppi upload` runs, **Then** no manifest entry contains git context, and the CLI performs no read of any repository's remote, branch, or commit.
2. **Given** `--link-prs` is NOT set, **When** the pre-upload summary renders, **Then** it states "PR linking: off" (or omits the git-context line entirely) so the user is never misled into thinking repo data is being sent.
3. **Given** a session whose working directory is a git repository, **When** uploaded without `--link-prs`, **Then** the absence of git context is identical to a session worked outside any repository — the default path does not distinguish them.

---

### User Story 3 — Audit the exact git metadata before any byte is sent (Priority: P1)

Before trusting the feature, a security-conscious developer runs `poppi upload --link-prs --dry-run --inspect`. The CLI computes the git context for every selected session and writes it into the inspection output alongside the redacted payload, transmitting nothing. The developer can read, per session, exactly which repository, branch, and commit will be reported, and confirm no embedded credentials, no absolute paths, and no unexpected repositories are present.

**Why this priority**: This is the same trust contract as `001` User Story 2, extended to the new metadata. Because git context is the one thing the CLI sends that is _not_ run through the redactor, the ability to inspect it before sending is what keeps the feature honest. If a user cannot see the repo/branch/commit values before they leave the machine, opt-in is not meaningful consent.

**Independent Test**: For a batch of sessions across two repositories, `poppi upload --link-prs --dry-run --inspect` writes an inspection artifact in which every git-context value that would be transmitted appears in human-readable form, transmits zero bytes to the network, and a textual search of the inspection output for a planted credential token in a repo remote URL returns zero hits.

**Acceptance Scenarios**:

1. **Given** `--link-prs --dry-run --inspect`, **When** the command runs, **Then** the inspection output records, per session, the git context that would be attached (repository identity, branch, commit) and no network request is made to any upload endpoint.
2. **Given** a repo remote with an embedded credential, **When** the inspection output is written, **Then** the credential value does not appear anywhere in the inspection output (consistent with US1 scenario 3).
3. **Given** the inspection output, **When** the developer reviews it, **Then** the per-session redaction summary clearly separates the redacted payload (anonymized) from the attached git context (intentionally un-redacted, opt-in), so the distinction between "redacted" and "intentionally sent in clear" is unambiguous.

---

### User Story 4 — Best-effort: sessions without resolvable git context degrade gracefully (Priority: P2)

A developer runs `poppi upload --link-prs` over a month of sessions, some worked in git repositories and some not (scratch directories, a repo since deleted, a detached-HEAD checkout, a repo with no remote). The CLI attaches git context where it can and silently omits it where it cannot — no session is dropped, no error is raised, and the batch completes normally. Sessions without git context simply will not link to a PR later.

**Why this priority**: Real session histories are messy. If `--link-prs` aborted or warned loudly on every session that is not a pristine git checkout with a remote, the feature would be unusable over a real backlog. Graceful degradation matches the cloud's own contract that a session with no PR metadata is excluded from PR views rather than treated as an error (cloud 005 Edge Cases).

**Independent Test**: A batch containing (a) a clean repo with a remote, (b) a directory that is not a git repo, (c) a repo with no remote configured, and (d) a working directory that no longer exists on disk, run with `poppi upload --link-prs`, completes successfully; only (a) carries git context; (b)/(c)/(d) carry none; the exit code is success.

**Acceptance Scenarios**:

1. **Given** a session whose working directory is not inside a git repository, **When** `--link-prs` runs, **Then** that session carries no git context and the batch proceeds without error.
2. **Given** a session in a git repository that has no remote configured, **When** `--link-prs` runs, **Then** the CLI omits the repository identity (it cannot be matched to a forge) and that session carries no git context; the batch proceeds.
3. **Given** a session whose recorded working directory no longer exists on disk, **When** `--link-prs` runs, **Then** the CLI omits git context for that session and continues.
4. **Given** that zero sessions in the batch yield resolvable git context while `--link-prs` is set, **When** the run completes, **Then** the CLI emits a single informational notice ("PR linking was on, but no sessions had resolvable git context") and still exits success — the empty result is not a failure.
5. **Given** `--link-prs` is set but git is unavailable on the machine, **When** the CLI cannot inspect repositories at all, **Then** it emits one clear notice that PR linking was skipped and proceeds with the upload as if the flag were off (the absence of git is not an upload failure).

---

### Edge Cases

- **Working directory recorded in the session ≠ a git repo root** (it's a subdirectory): the CLI MUST resolve upward to the enclosing repository root, the same way git itself does; the recorded repository identity is the enclosing repo.
- **Multiple remotes configured** (`origin`, `upstream`, a fork): the CLI MUST prefer `origin`; the selection rule is documented so the reported repository is deterministic.
- **Non-GitHub remote** (GitLab, Bitbucket, self-hosted): the git-context shape is forge-agnostic (host + `owner/name` + branch + commit), so the CLI records it regardless of host. Whether the cloud can _match_ a PR/MR for a non-GitHub host is the cloud's concern (GitHub-first per cloud 005); the CLI does not filter by host.
- **Detached HEAD** (no branch): the CLI records the commit SHA and omits the branch; a commit alone may still let the cloud match a PR.
- **Shallow clone / grafted history**: the commit SHA is still valid for matching; no special handling needed.
- **Branch name contains a ticket id or codename**: this is sent verbatim when opted in — the user consented by enabling `--link-prs`. The behaviour is documented so it is not a surprise.
- **Repository remote URL embeds a credential/token**: stripped to host + `owner/name` before recording — never recorded, summarised, inspected, or transmitted (US1 scenario 3). Treated as fail-closed: if the URL cannot be parsed into a clean host + `owner/name`, the CLI omits the repository identity rather than risk transmitting an unsanitised string.
- **Already-uploaded unchanged session re-run with `--link-prs`**: the incremental ledger classifies it `unchanged` (the redacted payload is identical), so it is skipped and does NOT retroactively gain git context. PR-link metadata attaches only to the `(new ∪ updated)` batch. Retroactive backfill of historical uploads is out of scope (see Out of Scope).
- **`--link-prs` combined with `--limit N`**: git context is computed only for the sessions that survive the `--limit` truncation (the canonical batch), consistent with `001` FR-006a.
- **Reading the repository must not trigger side effects**: the CLI MUST inspect repository state read-only and MUST NOT execute repository hooks or any operation that mutates the working tree, index, or refs.

## Requirements _(mandatory)_

### Functional Requirements

#### Opt-in surface

- **FR-001**: `poppi upload` MUST accept a `--link-prs` flag that is **off by default**. Git context is captured and attached only when the flag (or its documented persisted-config equivalent) is active. With the flag absent, `poppi upload` behaviour is byte-for-byte unchanged from `001-cli-ingest-client`.
- **FR-002**: When `--link-prs` is NOT active, the CLI MUST NOT read any repository's remote, branch, or commit, MUST NOT attach any git-context field to any manifest entry, and MUST NOT emit git/repo information in any output.
- **FR-003**: The CLI MAY support persisting the opt-in as a local configuration setting so the user need not pass `--link-prs` on every run; when both are present the explicit flag wins. The persisted setting MUST default to off and MUST be discoverable (surfaced in `--help` and in the pre-upload summary's "PR linking: on/off" line).

#### Git-context derivation (best-effort, read-only)

- **FR-004**: For each session in the upload batch (after `--limit` truncation), when `--link-prs` is active, the CLI MUST attempt to resolve the session's git context from the session's recorded working directory: locate the enclosing git repository, then read its remote identity, branch, and current commit. Resolution MUST be read-only and MUST NOT execute repository hooks or mutate the repository in any way.
- **FR-005**: The repository identity recorded MUST be normalised to host + `owner/name` (e.g. `github.com` + `acme/widgets`), derived from the `origin` remote (preferred when multiple remotes exist). Embedded credentials in the remote URL MUST be stripped before recording; if a clean host + `owner/name` cannot be parsed, the CLI MUST omit the repository identity (fail-closed) rather than record an unsanitised string.
- **FR-006**: The branch recorded SHOULD prefer the branch the session itself recorded at work time when the source provides it; otherwise the CLI MAY record the repository's current branch at upload time. When the repository is in a detached-HEAD state, the branch MUST be omitted and the commit retained.
- **FR-007**: The commit recorded MUST be the full commit SHA of the repository's current `HEAD` for that working directory at upload time.
- **FR-008**: Git-context resolution MUST be best-effort and non-fatal: any session whose working directory is missing, is not a git repository, has no usable remote, or otherwise cannot be resolved MUST carry no git context, MUST NOT raise an error, and MUST NOT abort or skip the upload of that session's redacted payload.
- **FR-009**: When `--link-prs` is active but git is entirely unavailable on the host, the CLI MUST emit one clear informational notice and proceed with the upload exactly as if the flag were off — the absence of git is not an upload failure.

#### Manifest contract (extends the `001` public manifest)

- **FR-010**: When git context is resolved for a session, the CLI MUST attach it to that session's manifest entry as an optional, additive `gitContext` object carrying at minimum: repository identity (host + `owner/name`), branch (optional), and commit SHA. This extends the `001-cli-ingest-client` manifest schema (`contracts/manifest.schema.json`, `ManifestEntry`) strictly additively — no existing field is renamed, removed, or made required — consistent with `001` FR-036 (additive changes are non-breaking).
- **FR-011**: Git context MUST be attached as manifest **metadata**, separate from the anonymized session payload. It MUST NOT be included in the bytes that are run through the anonymizer or PUT as the session payload, and therefore MUST NOT change the redacted-payload content hash the incremental ledger keys on (`001` FR-006c) — so enabling or disabling `--link-prs` does not by itself reclassify an otherwise-unchanged session.
- **FR-012**: The git-context fields MUST be a stable public contract (per `001` FR-036). The cloud consumes them per `poppi/specs/005` FR-024; any non-additive change requires the coordinated cross-repo bump process.

#### Trust gate: visibility and auditability

- **FR-013**: When `--link-prs` is active, the `poppi upload` pre-upload summary (`001` FR-020) MUST state that PR linking is on, report how many of the to-be-uploaded sessions will carry git context, and name the distinct repositories involved — so the user sees, before confirming, which repository identities will leave the machine.
- **FR-014**: When `--link-prs --dry-run --inspect` is used, the CLI MUST write the exact per-session git context that would be transmitted into the inspection output, transmit zero bytes (`001` FR-018), and present the git context distinctly from the redacted payload so the user can tell intentionally-sent-in-clear metadata apart from anonymized content.
- **FR-015**: No credential, token, or absolute filesystem path may appear in the attached git context, the pre-upload summary, or the inspection output. Repository identity is host + `owner/name` only; the absolute working-directory path used to locate the repo MUST NOT be transmitted or written to inspection output.

#### Machine-readable output

- **FR-016**: Under `--json` (`001` FR-039), the `upload-start` event and the final manifest-summary MUST carry the git context additively (e.g., per-session `gitContext`, and a batch-level count of sessions with git context). The additions MUST be strictly additive to the `001` event and summary contracts.

### Key Entities

- **Git context (per session, CLI-produced, opt-in)**: `{ repository: { host, owner, name }, branch?, commitSha }` resolved read-only from the session's working directory at upload time. Present only when `--link-prs` is active and resolution succeeds. Sent as manifest metadata, never as session payload, never run through the anonymizer. Credential- and path-free by construction (FR-005/FR-015).
- **Session↔PR link (cloud-owned, derived)**: the association the cloud computes by matching a session's git context against pull requests on the user's connected GitHub account (cloud 005 FR-024/FR-028). The CLI never computes or stores this link; it only supplies the inputs.
- **Repository identity**: host + `owner/name`, the forge-agnostic coordinate the cloud uses to scope PR matching. Derived from the `origin` remote, credential-stripped.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001 (default-off is provable)**: Across a representative batch run **without** `--link-prs`, 100% of manifest entries carry zero git-context fields and the CLI performs zero repository reads — verified against a mock server (no git fields in any request body) and a filesystem spy (no `.git` reads), even when sessions were worked inside git repositories.
- **SC-002 (opt-in completeness)**: For sessions whose recorded working directory is a git repository with an `origin` remote, ≥ 95% receive a git context whose repository `owner/name` and commit SHA match the on-disk repository — verified by a fixture of sessions across known repositories.
- **SC-003 (credential safety, fail-closed)**: For a fixture of `origin` remote URLs that embed credentials/tokens (https-with-token, ssh-with-user), 100% of recorded repository identities contain only host + `owner/name` and 0% contain any credential substring — verified by an automated assertion that the planted token never appears in the manifest, summary, or inspection output. Any remote URL that cannot be parsed into a clean identity yields **no** repository identity (not a partial/unsafe one).
- **SC-004 (auditable before send)**: With `--link-prs --dry-run --inspect`, 100% of git-context values that would be transmitted are present in the inspection output and 0 bytes are sent — verified by an inspection-content assertion plus a network spy asserting zero upload-endpoint hits.
- **SC-005 (graceful degradation)**: A mixed batch (in-repo, not-a-repo, no-remote, missing-directory, detached-HEAD) run with `--link-prs` exits success; only the resolvable sessions carry git context; no session's payload upload is dropped because its git context could not be resolved — verified by a fixture test.
- **SC-006 (additive, backward-compatible contract)**: A manifest produced with git context validates against the extended manifest schema, AND a consumer that ignores the `gitContext` field processes the manifest identically to one produced without the flag — verified by a schema test and a backward-compatibility test against the `001` manifest contract.
- **SC-007 (no ledger churn)**: Toggling `--link-prs` on a previously-uploaded, otherwise-unchanged session does NOT cause it to be reclassified as `updated` or re-uploaded — verified by an incremental-classification test that uploads without the flag, then re-runs with it, and asserts the session is classified `unchanged` and skipped.

## Assumptions

- **The cloud consumes this contract; cloud-side matching is deferred.** The GitHub OAuth connection, PR matching, cost-to-merge, and merge-rate computation live in the cloud (cloud 005 US5 / FR-023–FR-029) and are not yet shipped on the cloud roadmap. This CLI feature ships the producer side as forward-compatible groundwork; until the cloud consumer lands, attached git context is stored (cloud's reserved `pr_id` key) and unused — harmless.
- **Opt-in because repository identity is normally redacted.** Repo `owner/name` and branch names are the same class of identifying data the anonymizer redacts by default (`001` FR-011). Enabling `--link-prs` is the user's explicit, informed consent to transmit them; the default-off path is byte-for-byte the current behaviour.
- **v1 source is Claude Code.** Claude Code session logs record the working directory (and often the branch) the session ran in, which is what lets the CLI locate the repository. Additional source adapters (`001` FR-007) each define their own working-directory derivation when they are added; this spec does not foreclose them.
- **Read-only, side-effect-free git inspection.** The CLI inspects repository state without executing repository hooks or mutating the working tree, index, or refs.
- **Git context attaches to the `(new ∪ updated)` batch only.** It is computed at upload time for the sessions actually being uploaded; it does not retroactively backfill sessions already uploaded under a previous run.
- **The metadata shape is forge-agnostic.** Host + `owner/name` + branch + commit work for GitHub, GitLab, Bitbucket, and self-hosted forges. Whether the cloud can match a PR/MR for a given host is the cloud's concern (GitHub-first per cloud 005); the CLI records the context regardless of host.
- **No new exit codes.** PR-link metadata derivation is best-effort and never fatal, so this feature introduces no new failure modes or exit codes beyond the `001`/`004` contract.

## Out of Scope (for this spec)

- **Cloud-side PR matching, GitHub OAuth, merge-rate, and cost-to-merge** — owned by `poppi/specs/005-intelligence-post-processing` and its later plan.
- **Retroactive backfill** of git context onto sessions already uploaded — a `poppi link-prs --backfill`-style command (which would need to re-touch already-acknowledged sessions) is an explicit follow-up.
- **Explicit per-invocation PR pinning / manual override** (e.g. `--pr <number>` to force a session→PR association) — v1 derives repo/branch/commit automatically; manual overrides are follow-up.
- **Transmitting per-commit lists, diffs, changed-file paths, or any repository content** — only the forge-agnostic coordinate (host + `owner/name` + branch + HEAD commit) is sent.
- **Inferring PR associations by parsing session content** — explicitly forbidden by cloud 005 FR-024; the CLI derives context only from the repository, never from the (anonymized) session text.
- **Non-`origin` remote selection policy beyond "prefer origin"** — multi-remote disambiguation flags are follow-up.

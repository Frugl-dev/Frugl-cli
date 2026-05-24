# Phase 0 Research: poppi-cli PR-link metadata

**Feature**: 005-cli-pr-metadata | **Date**: 2026-05-24

## Scope

The spec resolved every cross-cutting product question with privacy-first defaults (opt-in vs. default-on → opt-in; real coordinates vs. hash → real, made safe by credential-stripping + auditability; see spec `checklists/requirements.md`). This document records the **implementation** choices the spec deferred to plan: how to locate the enclosing repo from a session's recorded `cwd`; how to derive a credential-free repository identity from `origin`; how to read branch + HEAD read-only with no hooks; why git context attaches as manifest metadata outside the redacted payload (so it never churns the `001` ledger); the `--link-prs` opt-in plus optional persisted config; and the best-effort, non-fatal degradation shape.

Each entry follows the **Decision / Rationale / Alternatives considered** format used by `001/research.md`.

---

## R-1: Where the per-session working directory comes from (FR-004)

**Decision**: For the `claude-code` source, read the working directory from the JSONL records themselves. Claude Code records a `cwd` string and a `gitBranch` string on its message records. The `001` `parse.ts` already JSON-parses every line but discards both. This feature surfaces them additively on `ParsedSession` (`cwd?`, `recordedBranch?`), taking the value from the first record that carries a non-empty `cwd` (and likewise for `gitBranch`). The git-context resolver consumes `cwd: string | undefined`; sources that cannot supply one yield no git context.

**Rationale**:

- It is the **session's own** working directory at work time, which is exactly what the spec's User Story 1 and FR-004 require ("from the session's recorded working directory") — not the CLI's `process.cwd()` at upload time, which is usually unrelated.
- Confirmed against live data: a real `~/.claude/projects/**/*.jsonl` record carries `"cwd": "/Users/.../poppi-cli"` and `"gitBranch": "main"`. The fields exist today; no new source instrumentation is needed.
- `gitBranch` directly satisfies FR-006's "prefer the branch the session itself recorded at work time when the source provides it" — we record the session's branch even if the repo has since moved to another branch at upload time.

**Alternatives considered**:

- _Use `process.cwd()` at upload time_ — rejected: that is the directory the user ran `poppi upload` from, almost never the session's repo; it would mislabel every session in a batch with one repo.
- _Re-derive the repo from the JSONL file's path under `~/.claude/projects/`_ — rejected: that path is a slug of the *project directory name*, lossy and not a real filesystem path; the recorded `cwd` is authoritative.
- _Require the branch from the live repo only_ — rejected: violates FR-006's preference for the work-time branch and would mislabel sessions whose repo has since switched branches.

---

## R-2: Read `.git` files directly vs. spawn the `git` binary (FR-004, FR-007, FR-009)

**Decision**: Resolve git context by **reading files under `.git/` directly** — `.git/config` for remotes, `.git/HEAD` + `.git/refs/**` + `.git/packed-refs` for branch and commit. Do **not** spawn a `git` subprocess for any of it.

**Rationale**:

- **Zero side effects, guaranteed (FR-004, spec Edge Cases "must not trigger side effects").** Reading ref files cannot run a hook, cannot touch the index/worktree/refs, cannot mutate anything. A `git` invocation — even a read-only one like `git remote get-url` — runs through git's config machinery and could, via aliases or `core.fsmonitor`/`core.hooksPath` configuration, trigger a process the user did not intend. File reads remove that entire class of risk and make the read-only guarantee auditable by inspection of one module.
- **No dependency on `git` being installed (FR-009).** If `.git/` is unreadable or absent, that is a clean best-effort "no context" path; we never depend on a `git` binary on `PATH`. FR-009's "git is entirely unavailable on the host" then maps to a simple, testable condition rather than catching a spawn-ENOENT.
- **Deterministic and fast.** A handful of `readFile` calls per repo, memoisable per `cwd`. No process spawn overhead across a large batch.
- The on-disk formats we need are stable and simple: `.git/config` is INI-like (`[remote "origin"] url = ...`); `.git/HEAD` is either `ref: refs/heads/<branch>` (attached) or a 40-hex SHA (detached); a branch ref is either a loose file `.git/refs/heads/<branch>` containing the SHA, or an entry in `.git/packed-refs`.

**Alternatives considered**:

- _`git remote get-url origin` + `git rev-parse HEAD` + `git symbolic-ref`_ — rejected: pulls in git's full config/alias/hook machinery, can't promise "no hooks" by construction, and needs `git` installed. The convenience is not worth weakening the central read-only guarantee of a trust-gate CLI.
- _A third-party "read git repo" library (e.g. isomorphic-git)_ — rejected: a heavy new dependency in a public-OSS audited binary for a job that is a few file reads; contrary to `001`'s zero-extra-dep posture (`001` R-3/R-4/R-5).
- _Worktree/submodule edge cases via `.git` being a file (gitdir pointer)_ — handled: when `.git` is a *file* (`gitdir: <path>`), follow the pointer once to the real git dir; if that fails to resolve cleanly, fail-closed to "no context" (FR-008).

---

## R-3: Repository-root resolution from a subdirectory `cwd` (spec Edge Cases)

**Decision**: Ascend from the resolved absolute `cwd` toward the filesystem root, at each level testing for a `.git` entry (directory or gitdir-pointer file). The first level that has one is the repository root. Stop at the filesystem root; if none is found, the session is "not in a repo" → no context. Memoise the `cwd → repoRoot|null` result per distinct `cwd` within one `poppi upload` invocation.

**Rationale**:

- Mirrors how git itself locates a repository, satisfying the spec's "working directory recorded in the session ≠ a git repo root (it's a subdirectory): resolve upward to the enclosing repository root."
- A session worked in `repo/packages/app` correctly reports `repo`'s identity.
- Memoisation keeps a 200-session batch that shares one repo to a single `.git/config` read (the Performance Goal in plan.md).

**Alternatives considered**:

- _Only check `cwd` itself for `.git`_ — rejected: misses the common subdirectory case the spec calls out explicitly.
- _Unbounded symlink following_ — rejected: cap at the filesystem root and do not follow symlinks past the first gitdir pointer, to avoid loops and surprises.

---

## R-4: Remote selection + identity normalization + credential stripping (FR-005, FR-015, SC-003)

**Decision**: From `.git/config`, select the `[remote "origin"]` `url` (prefer `origin` when multiple remotes exist; spec Edge Cases "multiple remotes"). Parse it into `{ host, owner, name }` and **strip any credential** before recording:

- `https://[user[:token]@]host/owner/name(.git)?` → drop the `userinfo`, keep `host`, split the path into `owner` + `name`, strip a trailing `.git`.
- `ssh://[user@]host[:port]/owner/name(.git)?` → drop `user`, keep `host`, split path.
- scp-style `git@host:owner/name(.git)?` → keep `host`, split the colon-path into `owner` + `name`.

If the URL does not parse into a clean `host` + non-empty `owner` + non-empty `name`, record **no** repository identity (fail-closed; FR-005). The credential substring is never assigned to any recorded field — the parser extracts host/owner/name into fresh strings and discards the rest, so a token can never survive into the manifest, summary, or inspection output.

**Rationale**:

- Host + `owner/name` is the forge-agnostic coordinate the cloud uses to scope PR matching (cloud `005` FR-024); it works for GitHub, GitLab, Bitbucket, and self-hosted (spec "forge-agnostic" Assumption).
- Fail-closed on unparseable URLs is the same discipline the anonymizer uses (Principle VI); a partial/unsafe identity is worse than none.
- Building host/owner/name as fresh extracted strings (rather than "redact the credential out of the original string") means there is no path by which any portion of the original URL — including the token — reaches a recorded field. SC-003 asserts the planted token appears in **zero** of {manifest, summary, inspection output}.

**Alternatives considered**:

- _Record the full remote URL and "redact" the credential in place_ — rejected: a regex-redact-in-place leaves the original string in memory near the output and risks a missed pattern; constructing fresh fields is strictly safer and is what fail-closed demands.
- _Hash the repo identity for privacy_ — rejected: defeats the entire feature; the cloud must match a *real* GitHub repo (spec `checklists/requirements.md`). Safety comes from credential-stripping + opt-in + auditability, not from hashing.
- _Support a configurable remote-selection policy now_ — rejected: out of scope per spec ("Non-`origin` remote selection policy beyond 'prefer origin'" is follow-up). v1 is "prefer origin", documented and deterministic.

---

## R-5: Branch and commit reading, including detached HEAD (FR-006, FR-007, spec Edge Cases)

**Decision**:

- **Branch (FR-006)**: prefer the session-recorded branch (`gitBranch` from R-1) when present and non-empty. Otherwise read `.git/HEAD`: if it is `ref: refs/heads/<branch>`, record `<branch>`; if it is a raw 40-hex SHA (detached HEAD), **omit** the branch (spec Edge Cases "detached HEAD") and keep the commit.
- **Commit (FR-007)**: resolve the full 40-hex `HEAD` SHA. If `.git/HEAD` points at `refs/heads/<branch>`, read the loose ref file `.git/refs/heads/<branch>`; if that file is absent, look the ref up in `.git/packed-refs`. If `.git/HEAD` is itself a raw SHA, use it directly. Record the full SHA (no truncation).

**Rationale**:

- FR-006 explicitly prefers the work-time branch the session recorded; R-1 supplies it, and it can differ from the repo's current branch at upload time. Falling back to live `HEAD` covers sources that don't record a branch.
- Detached-HEAD omitting the branch but keeping the commit matches the spec ("a commit alone may still let the cloud match a PR") and FR-006's MUST.
- Reading loose-then-packed refs is exactly how git stores branch tips; shallow clones / grafted history still have a valid `HEAD` SHA (spec Edge Cases "shallow clone") so no special handling is needed (FR-007).

**Alternatives considered**:

- _Always use the repo's current branch at upload time_ — rejected: violates FR-006's preference and mislabels sessions whose repo has since switched branches.
- _Resolve annotated-tag or symbolic indirection chains_ — not needed: `HEAD` resolution for branch tips is loose-or-packed; we do not need full revision-parsing. If resolution is ambiguous, fail-closed to "no commit" for that session (best-effort, FR-008).

---

## R-6: Git context attaches as manifest metadata, never as payload — the no-ledger-churn lock (FR-010, FR-011, SC-007)

**Decision**: The resolved `gitContext` is attached to the per-session **manifest entry** (an additive field on the manifest-create request body and on the public `ManifestEntry` contract). It is **never** included in the bytes that go through the anonymizer, and **never** part of the per-session payload PUT to the presigned URL. Specifically, it is excluded from the input to `anonymize()` and therefore from `AnonymizationResult.redactedHashHex`, which is what `001`'s ledger (`LedgerEntry.contentHash`) and classifier key on.

**Rationale**:

- `001` classification compares the current redacted-payload hash to the ledger's stored `contentHash` (data-model.md §8). Since `gitContext` never enters that hash, toggling `--link-prs` on a previously-uploaded, otherwise-unchanged session leaves the hash identical → it classifies `unchanged` → it is skipped. This is SC-007 ("no ledger churn") by construction, and it means git context attaches only to the `(new ∪ updated)` batch actually being uploaded (spec Assumption; no retroactive backfill).
- Keeping it as manifest metadata (alongside, not inside, the payload) is precisely the spec's FR-011 and User Story 1 scenario 4.
- It also keeps the un-redacted data out of the anonymizer's path entirely, so there is no risk the redactor "sees" and pseudonymizes the repo identity we deliberately want to send in clear.

**Alternatives considered**:

- _Embed git context inside the session payload_ — rejected: would route it through the anonymizer (which would redact the repo name and home paths it contains), defeating the feature, and would change `redactedHashHex` → churn the ledger → re-upload unchanged sessions (violates SC-007).
- _Store git context in the ledger_ — rejected: the ledger is never transmitted (`001` FR-006g) and persisting repo identity locally adds a privacy surface for no benefit; recompute at upload time instead.

---

## R-7: Opt-in surface — `--link-prs` flag plus optional persisted config (FR-001, FR-002, FR-003)

**Decision**: Add a boolean `--link-prs` flag to `poppi upload`, **default false**. Resolve the effective opt-in as: explicit `--link-prs` flag (if present) wins; otherwise the persisted `linkPrs` config value (FR-003); otherwise `false`. The persisted setting lives in a new `conf`-backed `poppi-config` namespace (default `linkPrs: false`) and is surfaced in `--help` and in the pre-upload summary's "PR linking: on/off" line. When the effective opt-in is **off**, the code path that resolves git context is never entered — no `cwd` is read, no `.git` is touched, no git field is attached or emitted (FR-002, the hard default-off guarantee).

**Rationale**:

- A boolean flag matches the spec's surface exactly and mirrors `001`'s flag conventions (`--dry-run`, `--confirm`, `--json`).
- "Explicit flag wins over persisted config" is the spec's FR-003 requirement and the principle-of-least-surprise default for CLI precedence (mirrors `001` R-13's flag > env precedence).
- Gating the *entire* resolution path behind the effective opt-in (rather than resolving-then-discarding) is what makes SC-001 provable: a filesystem spy sees zero `.git` reads in the default path. Resolving and discarding would technically leak repository reads even when off.

**Alternatives considered**:

- _Default-on with an opt-out flag_ — rejected: directly contradicts the feature's reason for existing (repo identity is normally redacted; sending it requires consent). FR-001 mandates default-off.
- _Flag only, no persisted config_ — acceptable but FR-003 explicitly permits the persisted equivalent for ergonomics over a backlog; we include it as an opt-in convenience that itself defaults to off.
- _An env var (e.g. `POPPI_LINK_PRS`)_ — out of scope; the spec names only the flag and the persisted config. Not foreclosed for a later spec.

---

## R-8: Best-effort, non-fatal degradation and the global notices (FR-008, FR-009, US4)

**Decision**: Per-session resolution is wrapped so that **any** failure (missing/nonexistent `cwd`, not a repo, no remote, unparseable remote, unreadable refs, detached with no resolvable SHA) yields `undefined` git context for that session and never throws. The session's redacted payload still uploads normally. Two **global** conditions emit exactly one informational notice each and still exit success:

- **Git unavailable on the host (FR-009 / US4 scenario 5)**: detected as "no session in the batch could even attempt a `.git` read because the relevant filesystem access fails wholesale." One notice ("PR linking was on, but git could not be inspected; proceeding as if --link-prs were off"), then proceed exactly as the default path.
- **Flag on, zero sessions resolved (US4 scenario 4)**: after resolving the batch, if `--link-prs` was active and **no** session yielded git context, emit one notice ("PR linking was on, but no sessions had resolvable git context") and exit success — the empty result is not a failure.

No new exit code is introduced (spec Assumption "No new exit codes").

**Rationale**:

- Real backlogs are messy (scratch dirs, deleted repos, detached HEAD, no remote); aborting or warning per session would make the flag unusable over a month of history (US4 rationale).
- Matches the cloud's own contract: a session with no PR metadata is excluded from the merge-rate denominator, not treated as an error (cloud `005` Edge Cases / FR-028).
- Honest-failures (Principle VI) is satisfied by surfacing the two *global* degradations the user genuinely needs to know about, while not spamming a notice per messy session (which would be noise, not signal).

**Alternatives considered**:

- _Warn per unresolved session_ — rejected: noise over a real backlog; the per-session "no link later" outcome is the documented, expected behaviour.
- _Treat "flag on but nothing resolved" as a non-zero exit_ — rejected: the spec is explicit that the empty result is success, not failure (US4 scenario 4).

---

## R-9: Auditability surfaces — pre-upload summary and `--dry-run --inspect` (FR-013, FR-014, FR-015, SC-004)

**Decision**:

- **Pre-upload summary (FR-013)**: when the opt-in is active, `formatSummaryForHuman` adds a `PR linking: on` line, a count ("Git context: N of M sessions"), and the distinct repository list ("repos: acme/widgets, acme/api"). When off, it prints `PR linking: off` (or omits the git line). The summary contains only host + `owner/name` (+ counts) — never a credential, never an absolute path (FR-015).
- **`--dry-run --inspect` (FR-014)**: the inspection writer adds, per session, the exact `gitContext` that would be transmitted, written **distinctly** from the redacted payload — e.g. a `gitContext` block in the per-session inspection record and/or a `git-context.json` sidecar — clearly labelled as "intentionally sent in clear (opt-in), NOT redacted." Dry-run transmits zero bytes (`001` FR-018).
- **Path-free invariant (FR-015)**: the absolute `cwd` used to locate the repo is used only transiently for resolution; it is never written into the manifest, summary, inspection output, or any `--json` event.

**Rationale**:

- This is the `001` User Story 2 trust contract, extended to the one field the CLI does not redact. If the user cannot see the repo/branch/commit before they leave the machine, opt-in is not meaningful consent (spec US3 rationale).
- Presenting git context *distinctly* from the redacted payload makes the "redacted vs. intentionally sent in clear" distinction unambiguous (FR-014 / US3 scenario 3).
- SC-004 asserts 100% of would-be-transmitted git-context values appear in the inspection output and a network spy sees zero upload-endpoint hits; SC-003 asserts a planted token appears nowhere in that output.

**Alternatives considered**:

- _Fold git context into the existing redaction-summary file unlabelled_ — rejected: blurs the redacted/un-redacted distinction the spec insists on (FR-014).
- _Show repo identity only in `--json`, not the human summary_ — rejected: the human pre-upload confirmation is where consent happens (FR-013); it must show what will leave the machine.

---

## R-10: Machine-readable `--json` additions (FR-016)

**Decision**: Additively extend the `001` `--json` contract:

- The `upload-start` NDJSON event gains an optional batch-level `gitContext` summary: `{ sessionsWithContext: number, repositories: string[] }` (the distinct `host/owner/name` list). Absent when the opt-in is off.
- The final manifest-summary (last stdout line) gains an optional `gitContext` block: `{ active: boolean, sessionsWithContext: number, repositories: string[] }`.
- Per-session git context travels in the manifest itself (R-6), which the final summary already references; the `session-start` event is **not** required to carry it (keeps per-session events lean), but MAY.

All additions are strictly additive: existing required fields and shapes are unchanged, and `001` consumers that ignore unknown fields (the `progress-event` schema mandates forward-compatibility) are unaffected.

**Rationale**:

- FR-016 requires the `upload-start` event and the final summary to carry git context additively, with a batch-level count.
- Reusing the existing `gitContext` vocabulary (same `host/owner/name` shape) keeps the contract coherent across the manifest, the events, and the summary.

**Alternatives considered**:

- _A new top-level event type for git context_ — rejected: a new event is a larger contract-surface change than additive fields on existing events, and `001`'s schema already mandates consumers tolerate unknown fields, so additive fields are non-breaking.
- _Per-session `gitContext` required on `session-start`_ — rejected: redundant with the manifest, and bloats every event; kept optional.

---

## Summary of locked decisions

| #    | Decision                                                                                  | Drives                |
| ---- | ----------------------------------------------------------------------------------------- | --------------------- |
| R-1  | Working dir from JSONL `cwd`; branch from recorded `gitBranch`                             | FR-004, FR-006        |
| R-2  | Read `.git/` files directly; never spawn `git` (no hooks, no git dependency)              | FR-004, FR-007, FR-009|
| R-3  | Ascend from `cwd` to enclosing repo root; memoise per `cwd`                               | FR-004, perf          |
| R-4  | Prefer `origin`; parse to host+owner/name; strip credentials; unparseable → omit          | FR-005, FR-015, SC-003|
| R-5  | Prefer recorded branch, else HEAD; detached → commit-only; full SHA via loose/packed refs | FR-006, FR-007        |
| R-6  | Attach as manifest metadata, outside payload/anonymizer/redactedHashHex                   | FR-010, FR-011, SC-007|
| R-7  | `--link-prs` flag default-off; flag > persisted `linkPrs` config > false; off = no reads  | FR-001, FR-002, FR-003|
| R-8  | Per-session best-effort non-fatal; two global notices; no new exit code                   | FR-008, FR-009        |
| R-9  | Summary names repos+counts; inspect writes context distinctly; path-/credential-free      | FR-013, FR-014, FR-015|
| R-10 | Additive `gitContext` on `upload-start` + final summary `--json`                          | FR-016                |

No `NEEDS CLARIFICATION` markers remain in the plan's Technical Context.

# Phase 0 Research: poppi-cli v1

**Feature**: 001-cli-ingest-client | **Date**: 2026-05-23

## Scope

The spec (and its `Clarifications → Session 2026-05-23` block) already resolved every cross-cutting question that would otherwise be a `NEEDS CLARIFICATION` in plan.md's Technical Context. The framework (oclif) and six foundation libraries (`zod`, `semver`, `p-retry`, `p-limit`, `@inquirer/prompts`, `conf`) are spec-level locks per the user directive recorded in spec.md's Dependencies → Foundation libraries.

This document records the remaining implementation choices the spec explicitly deferred to plan, plus the two locks the spec calls out as "to be locked in plan.md" (the `--limit` ordering criterion in FR-006a and the backoff schedule in FR-029a). Each entry follows the **Decision / Rationale / Alternatives considered** format.

---

## R-1: `--limit N` deterministic ordering (FR-006a)

**Decision**: After classification (FR-006d), order the (new ∪ updated) subset by **source-file modification time (mtime), descending**, with **canonical absolute source path lexicographic, ascending** as the tiebreaker. Apply `--limit N` by taking the first N.

**Rationale**:

- mtime-desc matches user intuition for `--limit 1`: "give me the session I most recently touched."
- The on-disk set is the only input; no clock skew across machines or runs.
- Lexicographic path is a deterministic tiebreaker for the (rare) case where two sessions share an mtime to the second.
- Stable across re-runs against the same on-disk set, satisfying the spec's "tester running `--limit 1` twice in a row sees the same session both times unless the underlying session set has changed."

**Alternatives considered**:

- _Pure lexicographic path ordering_ — rejected: surfaces the alphabetically-first project on disk every time, which is almost never the session a tester actually wants to verify against.
- _Reverse-discovery-order_ — rejected: discovery order under tinyglobby is not contractually stable across versions; depending on it would couple the spec to a transitive implementation.
- _Last-modified line within JSONL_ — rejected: requires parsing every file just to order them, which violates the SC-003a "classification of 1000 files in ≤ 5 s" budget for the limited case.

---

## R-2: `p-retry` backoff schedule (FR-029a)

**Decision**: 3 attempts total (1 initial + 2 retries), exponential factor 2, base 500 ms, **full jitter** in `[0, currentDelay]`, max single-attempt delay capped at 5 s. Per-request total wall-clock budget ≤ ~11 s in the worst case.

**Rationale**:

- The spec already locks the count (FR-029a: "target: 3 attempts total"). This entry locks the wait shape.
- Full jitter (per AWS Architecture Blog's well-known prescription) avoids retry thundering when a cloud-side blip causes many concurrent PUTs to fail in lockstep.
- 5 s per-attempt cap keeps the SC-003 60 s first-upload budget reachable even when a few of the (default 4) concurrent PUTs each consume their full retry envelope.
- `p-retry` accepts a `factor`, `minTimeout`, `maxTimeout`, and `randomize: true` configuration that matches this shape exactly — no custom backoff implementation needed.

**Alternatives considered**:

- _No jitter_ — rejected: spec already calls for jittered backoff and the AWS canonical write-up (and every library that has reckoned with thundering retries) confirms it matters at concurrency > 1.
- _Higher cap (15–30 s)_ — rejected: blows SC-003. The presign URLs are short-lived; retrying for half a minute against an expired URL is just slow failure.
- _More attempts (5+)_ — rejected: spec explicitly caps at "target: 3 attempts total." More attempts is silent over-retry, which Principle VI's Honest Failures discipline forbids.

---

## R-3: HTTP client

**Decision**: Use the Node 20+ built-in `fetch` (undici-backed) with an `AbortController`-driven per-request timeout (8 s for control-plane calls, 60 s for body PUTs against presigned URLs).

**Rationale**:

- Node 20 is the documented runtime floor (spec.md Dependencies → Framework & runtime constraints), and `fetch` is stable from Node 18 onward.
- Removes the explicit `undici` runtime dependency listed in the current scaffold — one fewer audited dep in a public OSS trust-gate.
- Headers, body streaming, AbortSignal cancellation, and `Response.body` ReadableStream are all standard and well-typed in `@types/node`.
- Per-request `AbortSignal.timeout(ms)` is the idiomatic API for the timeout requirement implied by FR-029a (transient = timeout is retryable).

**Alternatives considered**:

- _Keep explicit `undici` dep_ — rejected: redundant with built-in `fetch`. Reasonable if we needed `Agent`-level pool tuning, but for ~4 concurrent PUTs the defaults are fine.
- _`got` / `axios`_ — rejected: heavyweight; brings an unnecessary surface to the audited binary.
- _Node's `http`/`https` directly_ — rejected: re-derives a well-trodden surface (multipart, response decompression, redirect handling).

---

## R-4: Glob walker

**Decision**: `tinyglobby` (~5 KB, zero runtime deps, fast).

**Rationale**:

- v1 source-discovery surface is one glob: `~/.claude/projects/**/*.jsonl`. Anything heavier is overkill.
- `tinyglobby` is actively maintained, widely used in the toolchain (vite, vitest internally), and ships TypeScript types.
- Zero runtime deps reduces install-time supply-chain surface area for a public OSS CLI whose entire point is auditability.

**Alternatives considered**:

- _Node 22+ `fs.glob` / `fs.globSync`_ — rejected: requires Node ≥ 22; spec floor is Node 20.
- _`fast-glob`_ — rejected: heavier transitive tree, no perf win at the scale we care about (≤ 10⁴ files).
- _Hand-rolled `readdir` walk_ — rejected: re-derives a library without its tests.

---

## R-5: Hashing, UUID, gzip

**Decision**: All from Node built-in `crypto` and `zlib`:

- Content hash (FR-006b derivation-by-path-hash fallback, FR-006c ledger `contentHash`, FR-027b resume-state per-session hash): `crypto.createHash('sha256').update(buf).digest('hex')`. For files large enough to matter (rare in Claude Code JSONL but possible), use the streaming `pipeline(readStream, hashStream)` form.
- UUID for any client-side surrogate identifier (e.g. NDJSON event `id`): `crypto.randomUUID()`.
- gzip of the anonymized per-session payload before PUT: `zlib.gzip` / `zlib.createGzip` (decided per-session based on payload size; threshold confirmed empirically during implementation, default-on for payloads > 16 KB).

**Rationale**: Zero deps, well-audited, deterministic, available on every supported platform without native build.

**Alternatives considered**: None of the third-party hash/uuid/gzip libraries justify their install footprint when the built-in is available.

---

## R-6: Color and progress UI

**Decision**: `picocolors` (~700 bytes, zero deps) for color. Human-readable progress on stderr is **plain text per-session lines** (e.g. `[3/52] sess_abc — uploading 142 KB`), no spinners.

**Rationale**:

- Spinners fight stderr buffering, behave badly under `--json` (where stderr is reserved for diagnostics, FR-039), and confuse CI log capture.
- `picocolors` is the de-facto small color lib (ranked first by Antfu, used by vite/vitest themselves).
- Per-session text lines are grep-friendly, copy-pasteable into bug reports, and survive log truncation.

**Alternatives considered**:

- _`chalk`_ — rejected: 10× the install size for a feature we use ~5 places.
- _`ora` spinner_ — rejected: see above; bad fit for the dual stdout/stderr contract.
- _No color at all_ — rejected: SC-006 requires "human-readable error message naming the failure category"; color materially helps the user distinguish error categories at a glance.

---

## R-7: OS credential store library

**Decision**: `@napi-rs/keyring`. Replaces the `keytar` currently in `package.json` deps.

**Rationale**:

- `keytar` is deprecated/unmaintained (the upstream announced "no longer actively maintained" in 2022; no commits to main since).
- `@napi-rs/keyring` ships **prebuilt N-API binaries** for macOS, Windows, and the major Linux targets, eliminating the `node-gyp` build step at install time. For a public OSS CLI installed by developers across many platforms, removing the native build is a real UX win (and reduces the install-time blast radius for the supply chain).
- Same three-OS coverage as `keytar` (macOS Keychain, Windows Credential Manager, libsecret on Linux), so FR-004 is satisfied without surface change.
- `@napi-rs/keyring`'s `Entry` API maps cleanly to the existing `src/auth/keychain.ts` shape (`getToken`/`setToken`/`deleteToken`).

**Alternatives considered**:

- _Stay on `keytar`_ — rejected: maintenance status is a known liability for a security-sensitive trust-gate CLI.
- _Hand-roll three platform integrations_ — rejected: every cross-platform footgun warning the spec attaches to `conf` applies double here.
- _`keyring` (pure-JS, file-fallback)_ — rejected: violates FR-005 (no plaintext fallback) by design.

---

## R-8: Cloud HTTP boundary — direct fetch vs. `@supabase/supabase-js`

**Decision**: The CLI calls the cloud's documented Astro HTTP endpoints directly via Node `fetch`. It does **not** embed `@supabase/supabase-js`. Remove `@supabase/supabase-js` from the CLI's runtime dependencies.

**Rationale**:

- The cloud constitution (Principle III) requires "Server endpoints in Astro handle every authenticated read or write." So the cloud already exposes HTTP routes for OTP request, OTP verify, whoami, logout, manifest create, presign, complete. The CLI consumes those, not Supabase directly.
- Removing `supabase-js` from the CLI's bundle removes a large transitive tree (gotrue-js, postgrest-js, realtime-js, storage-js) from a binary whose auditability is its main pitch.
- Decouples CLI from Supabase-specific SDK semantics: if the cloud later swaps auth provider behind the same HTTP contract, the CLI is unaffected.
- Cloud-side rate-limiting, IP gating, and version-gate (FR-033) are enforced uniformly on the Astro routes regardless of which client speaks HTTP.

**Alternatives considered**:

- _Embed `supabase-js`_ — rejected: oversized, couples CLI to the SDK's idea of session refresh (which we don't want; we want explicit "re-run `poppi login`" per FR per the spec's expired-token edge case).
- _Use Supabase's REST-only API directly_ — rejected: same as above, slightly thinner; still ties CLI to one vendor surface. Going through the cloud's own Astro endpoints is the published contract per the cloud spec.

---

## R-9: Resume state vs. ledger storage — both via `conf`

**Decision**: Two separate `conf` instances under the OS-appropriate state directory (via `env-paths`):

- `poppi-resume-state` — in-flight upload identifier, expected session count, per-session ack status, per-session content hash recorded at first-run anonymization. Cleared on FR-028 completion call.
- `poppi-ledger` — keyed by `(endpoint URL, authenticated user ID)`; persists `{sessionId → {contentHash, lastUploadedAt, manifestId}}` across all uploads. Never cleared on completion.

**Rationale**:

- `conf` already gives atomic writes (write-temp-then-rename), schema validation, and the right per-OS state dir (`$XDG_STATE_HOME`/Library/`%APPDATA%`).
- Keeping the two stores separate keeps FR-027a (resume state can be discarded on stale upload identifier) decoupled from FR-006f (ledger loss is recoverable, but losing it is a wider event than losing one in-flight resume).
- Both stores live in the **state** directory (not config, not cache): config is user-editable, cache is OS-evictable; state is correct.

**Alternatives considered**:

- _Single combined `conf` file_ — rejected: harder to surgically clear resume state on completion without disturbing the ledger; harder to version-bump schemas independently.
- _Raw JSON file via `fs.writeFile`_ — rejected: re-derives `conf`'s atomic-write and state-dir-per-OS logic, which is exactly the footgun the spec called out.
- _SQLite (`better-sqlite3` etc.)_ — rejected: native dep at install time, overkill for two flat key-value stores.

---

## R-10: Per-source ID derivation when native sessionId is missing (FR-006b fallback)

**Decision**: When a session file lacks a native `sessionId` (future source types, or a malformed Claude Code JSONL), derive a stable identifier as:

```
sha256(canonicalize(absoluteSourcePath))[:24]   // first 96 bits, hex-encoded
```

Recorded in the manifest as `identityDerivation: "path-hash"`. Canonicalization uses Node's `path.resolve()` + lowercasing on case-insensitive filesystems (macOS HFS+/APFS default, Windows NTFS default; preserved as-is on Linux extfs).

**Rationale**:

- Stable per-machine: identical inputs yield identical hashes.
- Truncating to 24 hex chars (96 bits) keeps the identifier human-tractable in error messages and dashboards while keeping collision probability negligible at any realistic session count.
- Records the derivation method in the manifest so the cloud-side dedup logic can tell native vs. derived identifiers apart (relevant if a file later gains a native sessionId after a tool upgrade).

**Alternatives considered**:

- _Full sha256 hex (64 chars)_ — rejected: ugly in CLI output for no security gain.
- _Random UUID, persisted in a sidecar file_ — rejected: introduces "where do I store the sidecar" footgun and breaks the "same file on same machine yields same ID" property if the sidecar is lost.

---

## R-11: Output mode plumbing (`--json`, FR-038/039/040)

**Decision**: A single `OutputMode` (`'text' | 'json'`) is resolved at command-class start (from `--json` flag) and threaded through the orchestration layer as an explicit parameter. Output helpers (`progress.ts`, command-result emitters) accept it and switch sinks:

- `'text'` — human progress on stderr, final summary JSON on stdout.
- `'json'` — NDJSON progress events on stdout, diagnostics on stderr, final manifest-summary JSON appended as the last stdout line.

**Rationale**:

- Threading the mode is more honest than module-global state; it's testable per-call.
- Putting the final manifest-summary JSON on stdout in **both** modes (per FR-038) means a `--json`-blind caller can still `tail -n 1 | jq` and get a result.
- NDJSON events carry a monotonic `seq` and an `event` discriminator string from a closed enum, per the contract in `contracts/progress-event.schema.json`.

**Alternatives considered**:

- _Global singleton_ — rejected: hostile to vitest, and conceals the contract surface.
- _Distinct command flags per output kind_ — rejected: violates the spec's single `--json` flag convention (FR-039/040).

---

## R-12: Anonymization policy versioning (FR-017)

**Decision**: `POLICY_VERSION` is a single string constant in `src/anonymize/policy.ts`, of the form `v<MAJOR>.<MINOR>` (initial value `v0.1`). MAJOR bumps when a rule is **removed or weakened** (so a previously-redacted value would now be transmitted in the clear); MINOR bumps when a rule is **added or strengthened**. The version is recorded on every manifest (FR-017) and is part of the contract surface (FR-036).

**Rationale**:

- Manifest-level traceability of "all uploads made under policy version X" is the basis for the cloud-side incident-response playbook called out in constitution Principle VI ("A redaction gap is treated as an incident with a documented remediation path: purge + re-issue").
- Two-component string keeps the surface tiny and unambiguous; semver-with-patch would invite "is a typo fix a patch or a no-bump?" debates that don't matter for a closed ruleset.
- MAJOR=removal/weakening is the only direction that makes the cloud do work (it must distinguish old-policy and new-policy uploads when responding to a redaction-gap purge); other changes are append-only.

**Alternatives considered**:

- _Hash of the ruleset module_ — rejected: opaque, doesn't tell an auditor what changed, and changes on cosmetic edits.
- _Full semver (with patch)_ — rejected: invites patch-vs-minor debates with no operational difference.

---

## R-13: Endpoint resolution (FR-030/031)

**Decision**: Endpoint URL resolved in this fixed precedence: `--endpoint <url>` flag > `POPPI_ENDPOINT` env var > default `https://api.poppi.app`. Resolved value is logged to stderr (in text mode) and emitted in the structured command output (in `--json` mode). The CLI does NOT silently fall back to the default when an explicit endpoint is unreachable (per spec edge case "User passes `--endpoint` pointing at an unreachable host").

**Rationale**:

- Flag > env > default is the standard CLI precedence and makes shell scripts predictable.
- Logging the resolved endpoint makes "I thought I was on staging" mistakes immediately visible.
- Not falling back to default on unreachable explicit endpoint is critical for the local-stack test loop (SC-004) — silently uploading dev data to production would be a privacy incident.

**Alternatives considered**:

- _Env > flag (reversed)_ — rejected: violates principle of least surprise.
- _Auto-fallback to default on connection error_ — rejected: see above; explicit failure is the only honest behavior.

---

## R-14: Where the local Docker stack URL points

**Decision**: Document the local-stack endpoint as `http://localhost:54321` in `quickstart.md` and `.env.example`, matching the default Supabase local-development port used by the sibling `poppi/` repo. The CLI itself hardcodes nothing about this URL; users opt in via `POPPI_ENDPOINT=http://localhost:54321` or `--endpoint`.

**Rationale**: Already encoded in `.env.example` and the existing README. Keeps a single source of truth (the cloud repo's docker-compose definition).

**Alternatives considered**: None worth recording; this is purely documentation alignment.

---

## R-15: Per-session content hash — pre-redaction vs. post-redaction

**Decision**: The hash stored in the **resume state** (FR-027b) is over the **raw source-file bytes** (read once at first-run, used to detect on-disk mutation before resume reuses an already-anonymized identifier). The hash stored in the **ledger** (FR-006c) is over the **redacted payload bytes** (what the cloud actually received, used to decide whether the next run's redacted output differs).

**Rationale**:

- Resume cares about "did the source change since I anonymized it once?" → raw source bytes.
- Ledger cares about "does the cloud already have _this_ redacted payload?" → redacted bytes (a source change that the redactor entirely scrubs is, correctly, a no-op for the ledger).
- Hashing the redacted form in the ledger means an appended-but-fully-redacted turn (e.g. a turn that's all secrets) is properly skipped on re-upload rather than re-sent as "updated."

**Alternatives considered**:

- _Hash raw source in both_ — rejected: makes the appended-but-redacted edge case re-upload unnecessarily.
- _Hash redacted in both_ — rejected: resume can't compute the redacted hash without re-running anonymization, defeating the resume optimization.

---

## R-16: Pseudonym table lifetime (FR-016)

**Decision**: One `PseudonymTable` instance per `poppi upload` invocation. Lives in memory only. Seeded with the upload identifier so pseudonyms are deterministic within a run (useful for `--dry-run --inspect` reproducibility within a single invocation) but non-correlatable across runs (per FR-016: per-upload stable, NOT per-occurrence and NOT per-CLI-install).

**Rationale**: Spec is explicit. This entry just notes the implementation: HMAC-SHA-256 keyed by the upload identifier, truncated to a human-tractable length, prefixed by category (`proj_xxx`, `user_xxx`) so the dashboard can render category-aware labels.

**Alternatives considered**: None — direct spec consequence.

---

## R-17: Removal of the existing `delete` command stub

**Decision**: Delete `src/commands/delete.ts` from the scaffold during Phase 2. Account- and upload-deletion is deferred to follow-up spec `002-delete` (per spec.md Assumptions). The v1 surface lists exactly `login`, `logout`, `whoami`, `upload`.

**Rationale**: Shipping the stub command means `poppi --help` advertises a feature that always errors. That's a worse user experience than not advertising it at all, and the constitution's "Honest failures" discipline frowns on it.

**Alternatives considered**: _Keep stub for discoverability_ — rejected.

---

## Summary of locked decisions

| #    | Decision                                                        | Drives              |
| ---- | --------------------------------------------------------------- | ------------------- |
| R-1  | `--limit N` order: mtime desc, path asc tiebreaker              | FR-006a             |
| R-2  | Retry: 3 attempts, factor 2, base 500 ms, full jitter, cap 5 s  | FR-029a             |
| R-3  | HTTP: Node built-in `fetch` + AbortController                   | FR-022/023/032      |
| R-4  | Glob: `tinyglobby`                                              | FR-006              |
| R-5  | Hash/UUID/gzip: Node built-ins                                  | FR-006b/c/g         |
| R-6  | Color/progress: `picocolors`, no spinners                       | FR-038              |
| R-7  | Keychain: `@napi-rs/keyring` (replaces `keytar`)                | FR-004/005          |
| R-8  | No `supabase-js` in CLI bundle; talk to cloud's Astro endpoints | FR-001..003         |
| R-9  | Two `conf` namespaces under state dir: resume + ledger          | FR-006c, FR-026     |
| R-10 | Path-hash fallback identifier shape                             | FR-006b             |
| R-11 | OutputMode threaded as explicit parameter                       | FR-038/039/040      |
| R-12 | `POLICY_VERSION` = `v<MAJOR>.<MINOR>`                           | FR-017              |
| R-13 | Endpoint precedence: flag > env > default; no auto-fallback     | FR-030/031          |
| R-14 | Local stack default URL: `http://localhost:54321` (docs only)   | SC-004              |
| R-15 | Hash domain: raw bytes for resume, redacted bytes for ledger    | FR-006c, FR-027b    |
| R-16 | Per-upload pseudonym table, seeded by uploadId, in-memory       | FR-016              |
| R-17 | Delete the `delete` command stub                                | spec.md Assumptions |

No `NEEDS CLARIFICATION` markers remain in Technical Context.

# Phase 0 Research: frugl-cli org membership (`004-cli-org-join`)

**Feature**: 004-cli-org-join | **Date**: 2026-05-24

## Scope

The spec (and its cross-repo context) already resolved every cross-cutting question that would otherwise be a `NEEDS CLARIFICATION` in plan.md's Technical Context. The framework (oclif) and foundation libraries are inherited locks from `001-cli-ingest-client`; **this feature introduces no new dependencies** (spec Assumptions → "No new dependencies"). The cloud is the authority for all org/membership logic (spec Assumptions); the CLI is a thin reader/redeemer.

This document records the implementation decisions this feature makes **on top of** the `001` locks — chiefly how it reuses the existing HTTP/auth/retry/version-gate/output plumbing, how it maps the cloud's typed `/api/join` and `/api/orgs/me` responses to messages and exit codes, where org-context resolution slots into the upload pipeline, and the base32-Crockford normalization rules. Each entry follows the **Decision / Rationale / Alternatives considered** format and cites the `001` research item it builds on where relevant.

There are **no open `NEEDS CLARIFICATION` markers** in Technical Context.

---

## R-1: Reuse the `001` HTTP client unchanged for both new endpoints

**Decision**: `POST /api/join` and `GET /api/orgs/me` are issued through the existing `src/cloud/client.ts` (Node native `fetch`, `001` R-3) with no changes to the client itself. Two thin wrappers — `src/cloud/join.ts` (`redeemCode`) and `src/cloud/orgs.ts` (`getOrgContext`) — build the request, call the client, and `zod`-parse the response via `src/cloud/schemas.ts`. The CLI-version header (`X-Frugl-Client`, `001` FR-032) is attached automatically by the client, so the version gate (`426`) applies to both calls for free.

**Rationale**:

- The client already injects the bearer token, sets the version header, runs the version-gate intercept on `426`, applies per-request `AbortController` timeouts, and rethrows `ZodError` as `GENERIC_FAILURE`. Re-deriving any of that for `join`/`orgs/me` would duplicate the cross-repo drift sentinel and risk divergence.
- Both endpoints are control-plane JSON calls, identical in shape to the `001` `whoami`/manifest-create calls — the 8 s control-plane timeout (`001` R-3) fits.
- Keeping transport in `src/cloud/*.ts` (separate from command orchestration) matches the `001` boundary and keeps the new wrappers trivially unit-testable against a mock client.

**Alternatives considered**:

- _A bespoke fetch path inside `commands/join.ts`_ — rejected: would bypass the version-gate intercept and the ZodError-to-exit-code mapping, both of which are contract-load-bearing (FR-012/015).
- _A generic `cloud.get/post` helper introduced now_ — rejected: only two endpoints; two named wrappers read better and document the contract at the call site. A generic helper is a refactor for a later feature with more endpoints, not this one.

---

## R-2: `409 already_member` maps to exit **0**, not a failure code

**Decision**: When `POST /api/join` returns `409` with `error: "already_member"`, the CLI prints "You are already a member of `<Org>`." on **stdout** and exits **0** (`OK`). This is the single place where a non-2xx wire status maps to a success exit. Every other typed `/api/join` error maps to a non-zero code (see R-4).

**Rationale**:

- FR-017 / US1 scenario 4 are explicit: re-running `frugl join <code>` for an org you already belong to is an idempotent no-op from the user's perspective. The user asked "put me in this org"; they are in this org; the goal is satisfied.
- Treating it as a failure would break `frugl join <code> && frugl upload` chains for the common "I forgot I already joined" case.
- The org name for the message comes from the `already_member` response body. Per cloud `join.md` the success body carries `{ org: { id, name, slug } }`; the `already_member` error body follows the cloud's standard error shape `{ error, message, details }`. The CLI prints the server's `message` verbatim (which already names the org) rather than re-deriving it — see R-5.

**Alternatives considered**:

- _A dedicated `ALREADY_MEMBER` non-zero exit code_ — rejected: contradicts FR-017's "exit 0" and adds a code for a non-failure.
- _Silently exit 0 with no output_ — rejected: violates Honest Failures; the user should be told the current state.

---

## R-3: `GET /api/orgs/me` `409 org_required` means different things to `whoami` vs `upload`

**Decision**: The same `409 org_required` response is interpreted by call site:

- **`whoami`** (FR-025): a **reported state**, not an error. Print the identity + "Not a member of any organization yet." + both remedies, exit **0**.
- **`upload`** (FR-028): a **hard gate**. Print the onboarding-gate message, do no discovery/anonymization, transmit zero bytes, exit **`ORG_REQUIRED` (12)**.

`getOrgContext()` in `src/cloud/orgs.ts` returns a discriminated union — `{ kind: "member"; org; membership }` or `{ kind: "none" }` — rather than throwing on `409`. Each command decides what to do with `kind: "none"`. A `401` (no/expired session) is thrown as an `AuthError` from the wrapper (shared behaviour); only `org_required` is modelled as data.

**Rationale**:

- The two commands have genuinely different success conditions: `whoami` succeeds when authenticated (org membership is informational); `upload` cannot proceed without a destination. Modelling `org_required` as data (not an exception) lets each command apply its own policy without catching-and-re-deciding, which keeps the control flow honest (Principle VI).
- Returning a discriminated union mirrors the `001` `SessionClassification` pattern (data-model.md §8) — the codebase already reasons in tagged unions.

**Alternatives considered**:

- _Throw `OrgRequiredError` from the wrapper and catch it in each command_ — rejected: forces `whoami` to catch an "error" that is actually its normal no-org path, inverting the honest-failure posture and making the exit-0 case look like swallowed-exception code.
- _Two separate wrapper functions_ — rejected: same endpoint, same parse; the only difference is policy, which belongs in the command.

---

## R-4: Typed-error → exit-code mapping table for `POST /api/join`

**Decision**: `src/cloud/join.ts` translates each documented cloud `error` code into a typed error class (`src/lib/errors.ts`) carrying its exit code; `commands/join.ts` renders the user-facing message. The mapping (authoritative; mirrored in `contracts/join.md` and `contracts/exit-codes.md`):

| HTTP | cloud `error`       | CLI message (FR-016/017/018)                                                                                                      | Exit code                   |
| ---- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 200  | —                   | "✓ Joined `<name>` (`<slug>`) as `<role>`." + next-step line                                                                      | `OK` (0)                    |
| 400  | `validation_failed` | surface the server's `message` (format drifted past local check)                                                                  | `USAGE` (2)                 |
| 401  | `unauthorized`      | "Your session has expired. Run `frugl login` and try again."                                                                      | `AUTH_FAILURE` (10)         |
| 404  | `not_found`         | "Invite code not recognised. Check for typos or ask the admin to confirm the code."                                               | `JOIN_CODE_REJECTED` (70)   |
| 409  | `already_member`    | server `message` ("You are already a member of `<Org>`.") — **exit 0** (R-2)                                                      | `OK` (0)                    |
| 409  | `wrong_org`         | "You are already a member of `<details.current_org_name>`. Leave that organization … before joining `<details.target_org_name>`." | `ALREADY_IN_OTHER_ORG` (71) |
| 410  | `expired`           | "This invite code has expired. Ask the admin for a new one."                                                                      | `JOIN_CODE_REJECTED` (70)   |
| 410  | `revoked`           | "This invite code has been revoked. Ask the admin for a new one."                                                                 | `JOIN_CODE_REJECTED` (70)   |
| 410  | `exhausted`         | "This invite code has reached its usage limit. Ask the admin for a new one."                                                      | `JOIN_CODE_REJECTED` (70)   |
| 426  | `upgrade_required`  | shared version-gate message (current / required / upgrade command, `001` FR-033)                                                  | `VERSION_GATE_FAILURE` (50) |
| 429  | `rate_limited`      | "Too many join attempts. Try again in `<Retry-After>` seconds."                                                                   | `RATE_LIMITED` (72)         |
| 5xx  | `internal` / none   | bounded retry (R-6), then "couldn't reach the server, try again later."                                                           | `NETWORK_FAILURE` (40)      |

**Rationale**:

- `not_found`/`expired`/`revoked`/`exhausted` all share `JOIN_CODE_REJECTED` (70) because they are the same failure class from the user's standpoint — "this code can't be redeemed" — and the specific sub-reason is conveyed in the message and, under `--json`, the `error` field (FR-032). One code per failure _class_, not per HTTP status, keeps scripts simple while preserving the human detail.
- `wrong_org` gets its own code (71) because the remediation is fundamentally different (leave the other org first), and a script may want to branch on it specifically (e.g. surface a "contact your admin" path).
- `rate_limited` gets its own code (72) so automation can back off and retry later rather than treating it as a permanent rejection.
- `validation_failed` (400) maps to `USAGE` (2) — it means the server rejected the code shape even though local validation passed (format drift); it is a usage problem, not a network or rejection problem, and the CLI surfaces the server's message without retrying (spec edge case).

**Alternatives considered**:

- _One `JOIN_FAILED` code for all redemption errors_ — rejected: `wrong_org` and `rate_limited` need distinct scripting behaviour (different remediation, retryability).
- _A code per HTTP status_ — rejected: couples the public exit-code contract to HTTP status numbers that the cloud may consolidate; the failure _class_ is the stable contract.

---

## R-5: Interpolated message fields come from the response body, never client-derived

**Decision**: For `wrong_org`, the CLI interpolates `details.current_org_name` and `details.target_org_name` from the response body (FR-018). For `already_member`, it prints the server's `message` verbatim. For `rate_limited`, the seconds value comes from the `Retry-After` HTTP header when present, falling back to `details.retry_after_seconds` (FR-014). The CLI never hard-codes or guesses an org name or a retry interval.

**Rationale**:

- US3 scenario 2 is explicit: both names must be interpolated from the response, not guessed. The CLI has no other source of truth for the _other_ org's name — it deliberately never learned it.
- Preferring the `Retry-After` header over the body matches HTTP convention and the cloud `join.md` example (which sets both); the body field is the fallback for completeness.
- This keeps the CLI honest: it reports what the server said, not a plausible-looking reconstruction.

**Alternatives considered**:

- _Render a fixed "you're already in another org" string_ — rejected: loses the actionable org names; fails US3 scenario 2's verbatim-interpolation assertion.

---

## R-6: Bounded retry applies to transient failures only — identical predicate to `001`

**Decision**: `join` and `getOrgContext` reuse `src/lib/retry.ts`'s wrapper (`001` R-2: 3 attempts, factor 2, base 500 ms, full jitter, 5 s cap) with the **same** transient-only predicate (`001` FR-029a/b). Retryable: network reset, request timeout, HTTP 5xx. **Not** retryable and fail-fast: every typed `/api/join` 4xx (`400`/`404`/`409`/`410`), `401`, `426`, and — critically — `429 rate_limited` (FR-014: "MUST NOT auto-retry on rate-limit").

**Rationale**:

- `join` is atomic server-side (cloud `join.md`: single transaction with `FOR UPDATE` row lock), so there is no partial client state to repair on a transient retry — a retried `POST /api/join` either lands once or not at all, and a retry after a lost-but-committed response simply returns `409 already_member` (which is exit 0, R-2). Safe to retry transient failures.
- Not retrying `429` is a spec-level requirement (FR-014) and the right behaviour: the server is explicitly telling the client to back off; auto-retrying inside the command would defeat the rate limit and is dishonest about why the command is slow.

**Alternatives considered**:

- _Retry `429` with `Retry-After` backoff inside the command_ — rejected by FR-014; the user (or their automation) decides whether to retry, informed by the `RATE_LIMITED` (72) exit and the seconds in the message.

---

## R-7: Org-context resolution slots in **before** discovery/anonymization in the upload pipeline

**Decision**: In `commands/upload.ts`, `getOrgContext()` is called immediately after endpoint resolution + auth-token load, and **before** session discovery, classification, and anonymization. The resolved org context flows into `src/upload/summary.ts` (to name the destination, FR-029) and the `upload-start` progress event (FR-030). On `kind: "none"`, the command short-circuits to the `ORG_REQUIRED` gate (FR-028) with zero local work done — this gate fires for `--dry-run` too (FR-028, US5 scenario 3).

Placement in the existing `001` pipeline:

```
resolve endpoint → load auth token
  → getOrgContext()              # NEW (FR-027): the gate + destination resolution
      └─ kind:"none"  → ORG_REQUIRED gate, exit 12 (no discovery, no anonymize, 0 bytes)  # FR-028
      └─ kind:"member"→ continue, carry { org, role } forward
  → discover → classify → --limit → anonymize → summary (now names org)  # FR-029
  → confirm → pipeline PUTs → complete
```

**Rationale**:

- Resolving the destination _first_ is the whole point of US5: a brand-new user must hit a clear gate before any discover/anonymize work, not after a slow pass that only fails at the first cloud write (spec US5 "Why this priority"). Putting the call before discovery makes "zero bytes, zero anonymization, no inspection dir" (SC-008) structurally true, not merely best-effort.
- The summary builder (`001` FR-020) already runs after classification; threading the resolved `{ org, role }` into it (rather than re-fetching) means one `GET /api/orgs/me` per run and a consistent destination across the gate, the summary, and the event.
- The `--dry-run` gate (FR-028) is honest: a dry run that pretended an org existed would produce a misleading summary; the spec forbids it (US5 scenario 3).

**Alternatives considered**:

- _Resolve org lazily at first cloud write_ — rejected: defeats US5; the user pays for discovery + anonymization before learning they can't upload.
- _Skip the gate under `--dry-run`_ — rejected by FR-028; a dry run needs a real destination to be honest.
- _Cache org context across runs_ — rejected: spec Assumptions forbid new persistent state and require re-resolution so a server-side role/org change takes effect next run (no stale cache).

---

## R-8: `401`/`403` mid-upload (revoked Membership) → `AUTH_FAILURE`, resume state preserved

**Decision**: If a cloud call returns `401`/`403` **after** org context resolved but before the batch completes (e.g. an Admin revoked the Membership mid-upload, US5 scenario 4 / spec edge case), `commands/upload.ts` exits `AUTH_FAILURE` (10), preserves the `001` resume state (`001` FR-026/029c), and instructs the user to verify access and re-run. It does NOT downgrade to a partial success.

**Rationale**:

- This reuses the exact `001` behaviour for a mid-upload `401`/`403` (auth token died mid-run); a revoked Membership is just another reason the server now says "no." No new code path is needed beyond ensuring the existing `001` auth-failure handler sits on the org-aware cloud calls too.
- Preserving resume state means that if the user regains access (admin re-adds them) they resume cleanly rather than re-uploading from scratch (Honest Failures: "does not leave a half-written batch it cannot describe").

**Alternatives considered**:

- _A dedicated `MEMBERSHIP_REVOKED` exit code_ — rejected: the CLI cannot distinguish "token expired" from "membership revoked" from a `401`/`403` alone, and the remediation ("check your access, run `frugl login` if needed, re-run") is the same. `AUTH_FAILURE` is the honest, already-contracted code.

---

## R-9: New exit codes claim next-available numbers in the reserved gaps

**Decision**: Extend `src/lib/exit-codes.ts` (the `001` frozen `EXIT` table) with four new entries, claiming next-available numbers within the gaps the `001` exit-code contract reserved (12–19 in the auth/identity range; 70+ as the open tail). Existing codes are never reassigned (FR-033).

```ts
// additions to the 001 EXIT table (src/lib/exit-codes.ts)
ORG_REQUIRED: 12,          // auth/identity range gap (11 = KEYCHAIN_UNAVAILABLE)
JOIN_CODE_REJECTED: 70,    // first number in the reserved "70+" tail
ALREADY_IN_OTHER_ORG: 71,
RATE_LIMITED: 72,
```

**Rationale**:

- `001`'s `contracts/exit-codes.md` explicitly reserves "12–19 … 70+" as intentional reservation space and states new failure categories MAY claim next-available numbers there. `ORG_REQUIRED` is an auth/identity-adjacent state (you're authenticated but have no org), so 12 (next after `KEYCHAIN_UNAVAILABLE`=11) is the natural home. The three join-redemption codes cluster at 70–72, the start of the open tail, keeping them visually grouped as "the join feature's codes."
- FR-033 makes all of these — plus the reused `001` codes — part of the public contract; pinning them in the same `src/lib/exit-codes.ts` source-of-truth keeps the single-table invariant from `001` data-model.md §13.

**Alternatives considered**:

- _Put all four in the 70+ tail_ — rejected: `ORG_REQUIRED` is conceptually an auth/identity state, and the 12–19 gap exists precisely for that range; using it keeps the table's semantic grouping intact.
- _Reuse `NETWORK_FAILURE` (40) for `rate_limited`_ — rejected: a `429` is not a network failure; it is a deliberate server back-pressure signal that automation should treat differently (back off, retry later), which a distinct `RATE_LIMITED` (72) enables.

---

## R-10: base32-Crockford normalization + local validation (client-side, pre-network)

**Decision**: `src/join/normalize.ts` normalizes the raw argument before any network call (FR-004): **uppercase**, **strip whitespace**, **strip separator/non-Crockford characters** (hyphens and any other punctuation a user might paste). `src/join/validate.ts` then checks the normalized value (FR-005): the alphabet is restricted to the base32-Crockford set (`0-9A-Z` excluding `I`, `L`, `O`, `U`), and the length is within the documented bounds. Invalid input is rejected locally — **no network request** — and exits `USAGE` (2).

Crockford-specific normalization detail: the canonical Crockford decode treats `I`/`L` as `1` and `O` as `0`. Because the server's normalisation is authoritative (cloud `join.md`), the client's job is only to **reject obviously-malformed input early**, not to be the canonical decoder. The client therefore strips to the Crockford alphabet and validates length/alphabet; it sends the normalized string and lets the server do the authoritative hash lookup. (If a user types `O` for `0`, the client passes it through normalized-uppercase and the server's normalisation resolves it — the client does not silently rewrite glyphs, to avoid diverging from the server's rule.)

**Rationale**:

- Local rejection of malformed codes saves a round-trip and spares the server's redemption rate-limit from typo storms (spec edge cases: "Code longer than the documented maximum length" / "characters outside base32-Crockford"). FR-005 mandates it.
- The cloud `join.md` is explicit that **server normalisation is authoritative** and clients SHOULD normalise too to reject locally-malformed input. So the client's normalize+validate is a fast-fail optimization, not the source of truth — which is why the client does not attempt the canonical glyph substitution (that's the server's job) and only enforces the alphabet/length envelope.
- Keeping normalize/validate as pure functions in `src/join/` (no I/O) makes them trivially unit-testable, including the SC-005 assertion that the plaintext code never reaches default-level output.

**Alternatives considered**:

- _Do the full canonical Crockford decode client-side_ — rejected: risks diverging from the server's normalisation rule and re-implementing authoritative logic the server already owns; the client only needs to gate obviously-bad input.
- _Skip local validation, let the server reject_ — rejected by FR-005; wastes a round-trip and exposes the server rate-limit to client-side typos.

---

## R-11: The plaintext code is a secret — never logged at default level (SC-005)

**Decision**: The normalized and raw code values are treated as secret material. They appear in the `POST /api/join` request body and nowhere else at the default log level. Success/error messages name the **org**, never echo the code. Only an explicit `--debug` path may include the code, and the help text + docs warn that debug output can contain secrets (FR-006). A unit test runs `frugl join <code>` at default level and asserts the captured stdout+stderr does not contain the code (SC-005).

**Rationale**:

- The invite code grants org access (cloud spec 003 treats it as sha256-hashed-at-rest secret material). Echoing it into terminal scrollback, CI logs, or a pasted bug report would be a credential leak (Principle VI / FR-006).
- Reusing the `001` `--debug` convention (debug may include secrets, with a docs warning) keeps a consistent posture across the CLI rather than inventing a new redaction rule.

**Alternatives considered**:

- _Echo the normalized code on success for confirmation_ — rejected: a confirmation that leaks the credential; naming the org is the right confirmation and is not secret.

---

## R-12: `--json` extensions are strictly additive to the `001` contract

**Decision**: `frugl join --json` emits a single `JoinResult` object (success: `{ command: "join", ok: true, org, membership }`; error: `{ command: "join", ok: false, error, message }`) on stdout, matching the `001` FR-040 uniform machine contract. `frugl whoami --json` gains an additive `organization` field (the org object or `null`) on its existing `WhoamiResultOk` (FR-026). The `upload-start` NDJSON event gains an additive `organization: { id, slug }` (FR-030). No existing `001` field is renamed or removed; consumers tolerant of unknown fields (per the `001` progress-event schema's forward-compatibility note) are unaffected.

**Rationale**:

- A single parsing contract across every command is the `001` FR-040 goal for the eventual MCP wrapper; `join`'s result object slots into the existing `command-output` `oneOf`. The `whoami` and `upload-start` additions are strictly additive, which the `001` progress-event schema explicitly permits ("Consumers MUST tolerate … unknown fields within a known type").
- Modelling the no-org case for `whoami` as `organization: null` (rather than omitting the field) gives consumers a stable presence/absence signal without a separate result variant.

**Alternatives considered**:

- _A new `whoami` result variant for the no-org case_ — rejected: the no-org state is still a successful `whoami` (`ok: true`, exit 0); a nullable field is the additive, backward-compatible expression of it.
- _Renaming/removing any existing field to fit org context_ — rejected: would break the `001` contract and require a coordinated cross-repo bump (FR-033) for no benefit.

---

## Summary of locked decisions

| #    | Decision                                                                                                 | Drives             |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------------ |
| R-1  | Reuse `001` `src/cloud/client.ts` unchanged; two thin wrappers (`join.ts`, `orgs.ts`)                    | FR-011/024/027     |
| R-2  | `409 already_member` → exit **0** with "already a member" message                                        | FR-017, SC-004     |
| R-3  | `409 org_required` = reported state for `whoami` (exit 0), hard gate for `upload` (12)                   | FR-025/028         |
| R-4  | Typed `/api/join` error → exit-code mapping (70/71/72 + reused 2/10/50/40)                               | FR-014/016/017/018 |
| R-5  | Interpolated message fields come from the response body / `Retry-After`, never guessed                   | FR-014/018, SC-003 |
| R-6  | Bounded retry on transient only; `429` fails fast (no auto-retry)                                        | FR-013/014         |
| R-7  | Org context resolved BEFORE discovery/anonymization; gate fires for `--dry-run` too                      | FR-027/028, SC-008 |
| R-8  | `401`/`403` mid-upload → `AUTH_FAILURE`, resume state preserved                                          | FR-031             |
| R-9  | New exit codes: `ORG_REQUIRED`=12, `JOIN_CODE_REJECTED`=70, `ALREADY_IN_OTHER_ORG`=71, `RATE_LIMITED`=72 | FR-032/033         |
| R-10 | Client normalizes (uppercase/strip) + validates (alphabet/length); server is authoritative               | FR-004/005         |
| R-11 | Plaintext code is secret; never at default log level; `--debug` only, with warning                       | FR-006, SC-005     |
| R-12 | `--json`: new `JoinResult`; additive `organization` on `whoami` + `upload-start`                         | FR-021/026/030     |

No `NEEDS CLARIFICATION` markers remain in Technical Context.

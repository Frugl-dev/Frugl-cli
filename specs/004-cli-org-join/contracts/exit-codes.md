# Exit Codes — additions for `004-cli-org-join`

**Feature**: 004-cli-org-join | **FR**: FR-032 / FR-033 | **Status**: contract surface (FR-036)

This document records the exit-code **additions** this feature makes to the `001-cli-ingest-client` exit-code contract (`specs/001-cli-ingest-client/contracts/exit-codes.md`). The `001` contract is the base; the codes below extend it. Existing `001` codes are **reused unchanged and never reassigned** (FR-033).

The single source of truth in code is `src/lib/exit-codes.ts` (the same frozen `EXIT` table `001` established). Scripts and the future MCP wrapper branch on these codes; they never shift between releases without a coordinated cross-repo bump (FR-033).

---

## Additions

| Code | Symbol                 | When                                                                                                                                                                                                                                                                           | Triggering FR / edge case                                                                   |
| ---: | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `12` | `ORG_REQUIRED`         | Authenticated but the caller has no Organization Membership. Emitted by `poppi upload` only — `GET /api/orgs/me` returned `409 org_required` and upload cannot proceed without a destination. `poppi whoami` does NOT use this code (it reports the no-org state and exits 0). | FR-028; US5; spec edge case "`GET /api/orgs/me` returns `409 org_required` during `upload`" |
| `70` | `JOIN_CODE_REJECTED`   | The invite code is not redeemable: `404 not_found`, `410 expired`, `410 revoked`, or `410 exhausted`. The specific sub-reason is in the user-facing message and, under `--json`, the `error` field.                                                                            | FR-016; US3                                                                                 |
| `71` | `ALREADY_IN_OTHER_ORG` | One-org-per-user conflict: the caller is already a Member of a _different_ Organization (`409 wrong_org`). Message names the current and target orgs from `details`.                                                                                                           | FR-018; US3                                                                                 |
| `72` | `RATE_LIMITED`         | The per-origin redemption rate-limit was tripped (`429 rate_limited`). The CLI does not auto-retry; the wait interval is in the message (from `Retry-After`).                                                                                                                  | FR-014; US3; spec edge case "Network unreachable" (distinct from rate-limit)                |

These claim next-available numbers in the gaps the `001` contract reserved: `ORG_REQUIRED` takes `12` from the auth/identity range (11 = `KEYCHAIN_UNAVAILABLE`); the three join-redemption codes occupy `70`–`72`, the start of the `001`-reserved "70+" tail (R-9).

---

## Reused `001` codes (this feature)

This feature also emits these existing `001` codes unchanged; they are part of the public contract for the join/org-aware flows (FR-033):

| Code | Symbol                 | When (this feature)                                                                                                                                                                                       |
| ---: | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  `0` | `OK`                   | `join` success; `join` on `409 already_member` (idempotent no-op, R-2 / FR-017); `whoami` (incl. no-org state, FR-025).                                                                                   |
|  `1` | `GENERIC_FAILURE`      | Any consumed-endpoint response that fails `zod` schema validation (contract drift, FR-012 / SC-006).                                                                                                      |
|  `2` | `USAGE`                | Locally-malformed code (alphabet/length, FR-005); missing/extra positional arg; `400 validation_failed` from `/api/join` (server-side format drift, spec edge case).                                      |
| `10` | `AUTH_FAILURE`         | No stored token (FR-008); `401` from any consumed endpoint (FR-010); `401`/`403` mid-upload after org resolution (FR-031 / R-8).                                                                          |
| `11` | `KEYCHAIN_UNAVAILABLE` | OS credential store unreachable when reading the token (FR-009).                                                                                                                                          |
| `40` | `NETWORK_FAILURE`      | Transient failure (`5xx` / network reset / timeout) after bounded-retry exhaustion on `/api/join` or `/api/orgs/me` (FR-013); `GET /api/orgs/me` transient exhaustion aborts `upload` before anonymizing. |
| `41` | `ENDPOINT_UNREACHABLE` | An explicit `--endpoint` / `POPPI_ENDPOINT` host unreachable from the first attempt (spec edge case "Network unreachable").                                                                               |
| `50` | `VERSION_GATE_FAILURE` | `426 upgrade_required` from any consumed endpoint (FR-015), shared version-gate behaviour.                                                                                                                |

---

## Mode-independent

These codes are emitted regardless of text vs `--json` mode. In `--json` mode the structured error body is written to stderr (diagnostics) and the result object to stdout; the exit code is the machine-actionable signal (matches `001` convention).

## Forward-compatibility

Consistent with the `001` contract: new failure categories MAY claim next-available numbers within the gapped ranges (`13`–`19`, `21`–`29`, `31`–`39`, `42`–`49`, `51`–`59`, `61`–`69`, `73`+). Existing codes — `001`'s and the four above — MUST NOT be reassigned (FR-033).

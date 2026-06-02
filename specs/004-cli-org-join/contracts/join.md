# Cloud HTTP Boundary: `POST /api/join` (consumed by `frugl join`)

**Feature**: 004-cli-org-join | **Date**: 2026-05-24 | **Status**: contract surface (FR-036)

This document records what the CLI expects from the cloud's `POST /api/join` endpoint — verbatim consumer expectations against the cloud's `003-org-membership-permissions` spec (`frugl/specs/003-org-membership-permissions/contracts/join.md`). **Any change here MUST be coordinated with the cloud repo per the spec's "Cross-repo context" section.**

This layers onto the existing cloud HTTP boundary documented in `specs/001-cli-ingest-client/contracts/cloud-api.md`; the common request headers and common response-status semantics from that document apply unchanged (bearer token, `X-Frugl-Client` version header, `426`/`5xx`/network handling). This file records only the `/api/join`-specific shapes and the `/api/join`-specific error → exit-code mapping.

The endpoint is `POST /api/join` on the resolved endpoint host (default `https://api.frugl.app`; overridable via `--endpoint` / `FRUGL_ENDPOINT`, FR-002). The response shapes below are mirrored as `zod` schemas in `src/cloud/schemas.ts`; the CLI runs `Schema.parse()` on every body, and a `ZodError` becomes `GENERIC_FAILURE` (1) — the cross-repo drift sentinel (Principle VI, FR-012, SC-006).

---

## Request

**Method + path**: `POST /api/join`

**Headers** (per `001` common headers):

| Header           | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| `Authorization`  | `Bearer <token>` from the OS keychain                 |
| `X-Frugl-Client` | `frugl-cli/<semver>` (enables the `426` version gate) |
| `Content-Type`   | `application/json`                                    |

**Body** (FR-011):

```json
{ "code": "ACME7K3P9XR2NMQH" }
```

`code` is the **normalized** invite code (R-10 / FR-004): uppercased, whitespace and separator/non-Crockford characters stripped. The CLI validates length + base32-Crockford alphabet locally first (FR-005) and never sends a locally-malformed code. `redaction_policy_version` and `org_id` MUST NOT appear in the body (FR-023; the CLI never sends `org_id`, cloud FR-023).

**Pre-network fast-fails** (no request issued):

| Condition                                 | Behaviour                                                        | Exit code                   |
| ----------------------------------------- | ---------------------------------------------------------------- | --------------------------- |
| No token in keychain                      | "You're not signed in. Run `frugl login` first…" (FR-008)        | `AUTH_FAILURE` (10)         |
| Keychain unavailable                      | "Secure token storage required" (same class as `upload`, FR-009) | `KEYCHAIN_UNAVAILABLE` (11) |
| Code fails local alphabet/length (FR-005) | "Invite code contains unexpected characters." / "…wrong length…" | `USAGE` (2)                 |
| Missing / multiple positional args        | oclif required-/strict-args usage error                          | `USAGE` (2)                 |

---

## Success (`200 OK`)

```json
{
  "org": { "id": "uuid", "name": "Acme Corp", "slug": "acme" },
  "membership": { "id": "uuid", "role": "member", "joined_at": "2026-05-23T15:00:00Z" }
}
```

**CLI behaviour** (FR-019): print a human success line on **stdout** naming the org (`name` + `slug`) and the granted `role` **verbatim**, plus one next-step line:

```
✓ Joined Acme Corp (acme) as member.
  You can now run `frugl upload` to send sessions to this organization.
```

Exit `OK` (0). Under `--json`, emit the `JoinResult` success object (see `command-output.schema.json`).

---

## Error → message → exit-code mapping

The CLI recognises each documented typed error, renders the actionable message (FR-016/017/018), and exits with the mapped code. Error bodies follow the cloud's standard shape `{ "error": <code>, "message": <string>, "details"?: {…} }` (cloud `README.md`).

| HTTP | `error`             | CLI user-facing message                                                                                                                          | Exit code                   | Retry? |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------ |
| 400  | `validation_failed` | surface the server's `message` (local check passed but server format drifted)                                                                    | `USAGE` (2)                 | no     |
| 401  | `unauthorized`      | "Your session has expired. Run `frugl login` and try again."                                                                                     | `AUTH_FAILURE` (10)         | no     |
| 404  | `not_found`         | "Invite code not recognised. Check for typos or ask the admin to confirm the code."                                                              | `JOIN_CODE_REJECTED` (70)   | no     |
| 409  | `already_member`    | server `message` — "You are already a member of `<Org>`." — **exit 0** (idempotent no-op, R-2 / FR-017)                                          | `OK` (0)                    | no     |
| 409  | `wrong_org`         | "You are already a member of `<details.current_org_name>`. Leave that organization on the dashboard before joining `<details.target_org_name>`." | `ALREADY_IN_OTHER_ORG` (71) | no     |
| 410  | `expired`           | "This invite code has expired. Ask the admin for a new one."                                                                                     | `JOIN_CODE_REJECTED` (70)   | no     |
| 410  | `revoked`           | "This invite code has been revoked. Ask the admin for a new one."                                                                                | `JOIN_CODE_REJECTED` (70)   | no     |
| 410  | `exhausted`         | "This invite code has reached its usage limit. Ask the admin for a new one."                                                                     | `JOIN_CODE_REJECTED` (70)   | no     |
| 426  | `upgrade_required`  | shared version-gate message (current / required / upgrade command, `001` FR-033)                                                                 | `VERSION_GATE_FAILURE` (50) | no     |
| 429  | `rate_limited`      | "Too many join attempts. Try again in `<Retry-After>` seconds."                                                                                  | `RATE_LIMITED` (72)         | no     |
| 5xx  | `internal` / none   | bounded retry (`001` FR-029a), then "couldn't reach the server, try again later."                                                                | `NETWORK_FAILURE` (40)      | yes    |

**Notes on the mapping**:

- The four redemption-rejection reasons (`not_found`, `expired`, `revoked`, `exhausted`) share one exit code (`JOIN_CODE_REJECTED`, 70) because they are one failure class to a script; the sub-reason is in the message and the `--json` `error` field (FR-032 / R-4).
- `wrong_org` interpolates `details.current_org_name` and `details.target_org_name` from the body verbatim — the CLI never guesses org names (FR-018 / R-5).
- `rate_limited` reads the seconds from the `Retry-After` HTTP header when present, falling back to `details.retry_after_seconds` (FR-014 / R-5). It is NOT auto-retried (FR-014).
- `already_member` is the only non-2xx status that maps to exit 0 (R-2).
- A `200` (or any body) that does not match the documented schema → `GENERIC_FAILURE` (1), contract violation (FR-012, US3 scenario 5).

---

## `wrong_org` error body (interpolated fields)

```json
{
  "error": "wrong_org",
  "message": "You are already a member of Beta Inc. Leave that organization on the dashboard before joining Acme Corp.",
  "details": {
    "current_org_name": "Beta Inc",
    "current_org_slug": "beta",
    "target_org_name": "Acme Corp"
  }
}
```

The CLI interpolates `details.current_org_name` and `details.target_org_name` into its rendered message (FR-018).

## `rate_limited` response (header + body)

```
HTTP/1.1 429 Too Many Requests
Retry-After: 47
Content-Type: application/json

{ "error": "rate_limited", "message": "Too many join attempts. Try again in 47 seconds.", "details": { "retry_after_seconds": 47 } }
```

---

## Output discipline

- On **success**, the human message is on **stdout**; exit 0.
- On **any error path**, the user-facing message is on **stderr** and stdout is kept empty, so `frugl join <code> && …` chains correctly (FR-020).
- Under `--json`, the single result object is on stdout and diagnostics on stderr (FR-021), matching the `001` FR-040 contract.
- The plaintext code NEVER appears in stdout/stderr at the default log level, nor in the `--json` object (SC-005 / FR-006). `--debug` may include it, with a docs warning.

## Contract testing

Per the `001` contract-test convention (`zod` round-trip + behaviour assertion), this endpoint has:

1. **Happy path** — `200` body parses; success message names org + role verbatim; exit 0.
2. **Each typed error** — one canned-response test per row of the mapping table asserts the documented message + exit code + that no further network request is made (SC-003).
3. **`already_member`** — exit 0, "already a member" message (SC-004).
4. **No auth** — zero network requests, `AUTH_FAILURE` (SC-002).
5. **Malformed success body** — `GENERIC_FAILURE` (SC-006).
6. **No-leak** — captured output never contains the code (SC-005).

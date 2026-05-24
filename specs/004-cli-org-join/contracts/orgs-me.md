# Cloud HTTP Boundary: `GET /api/orgs/me` (consumed by `poppi whoami` + `poppi upload`)

**Feature**: 004-cli-org-join | **Date**: 2026-05-24 | **Status**: contract surface (FR-036)

This document records what the CLI expects from the cloud's `GET /api/orgs/me` endpoint — verbatim consumer expectations against the cloud's `003-org-membership-permissions` spec (`poppi/specs/003-org-membership-permissions/contracts/orgs.md`). **Any change here MUST be coordinated with the cloud repo.**

This layers onto the existing cloud HTTP boundary in `specs/001-cli-ingest-client/contracts/cloud-api.md`; the common headers and common response-status semantics from that document apply unchanged. This file records only the `/api/orgs/me`-specific shapes and how the **two** consuming commands (`whoami`, `upload`) interpret the same response differently.

The endpoint is `GET /api/orgs/me` on the resolved endpoint host (default `https://api.poppi.app`; overridable via `--endpoint` / `POPPI_ENDPOINT`, spec edge case). Response bodies are mirrored as `zod` schemas in `src/cloud/schemas.ts`; a `ZodError` becomes `GENERIC_FAILURE` (1), the cross-repo drift sentinel (FR-012, SC-006).

---

## Request

**Method + path**: `GET /api/orgs/me`

**Headers** (per `001` common headers): `Authorization: Bearer <token>`, `X-Poppi-Client: poppi-cli/<semver>`. No request body.

**Pre-network fast-fails** (no request issued): no token → `AUTH_FAILURE` (10); keychain unavailable → `KEYCHAIN_UNAVAILABLE` (11). (For `whoami`, this matches the unchanged `001` "not logged in" path; for `upload`, the unchanged `001` auth gate.)

---

## Success (`200 OK`)

```json
{
  "org": {
    "id": "uuid",
    "name": "Acme Corp",
    "slug": "acme",
    "member_count": 7,
    "created_at": "2026-05-23T15:00:00Z"
  },
  "membership": { "role": "owner", "joined_at": "2026-05-23T15:00:00Z" }
}
```

Resolved internally as `OrgContext { kind: "member", org, membership }` (data-model.md §3). `role` is one of `owner | admin | member`, printed verbatim.

---

## `409 org_required`

```json
{ "error": "org_required" }
```

Resolved internally as `OrgContext { kind: "none" }` (data-model.md §3) — **modelled as data, not thrown** (R-3), so each command applies its own policy.

---

## Per-command interpretation

The same response drives two different success conditions (R-3):

| Response           | `poppi whoami` (FR-024/025)                                                                                                                           | `poppi upload` (FR-027/028)                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200` (member)     | Report email + "Organization: `<name>` (`<slug>`) — `<member_count>` members" + "Your role: `<role>`". Exit 0.                                        | Carry `{ org, role }` into the pre-upload summary (FR-029) and the `upload-start` event (FR-030). Continue the pipeline.                                                                                                           |
| `409 org_required` | Report email + "Not a member of any organization yet." + both remedies (`poppi join <code>` / dashboard). **Exit 0** — reported state, not a failure. | **`ORG_REQUIRED` gate**: onboarding-gate message naming both remedies; **no** discovery/anonymization; transmit **zero bytes**; write **no** inspection dir. Exit `ORG_REQUIRED` (12). Fires for `--dry-run` too (US5 scenario 3). |
| `401 unauthorized` | Unchanged `001` "not logged in" message. Exit `AUTH_FAILURE` (10).                                                                                    | Unchanged `001` auth gate. Exit `AUTH_FAILURE` (10).                                                                                                                                                                               |
| `426`              | Shared version-gate message. Exit `VERSION_GATE_FAILURE` (50). No retry.                                                                              | Shared version-gate message. Exit `VERSION_GATE_FAILURE` (50). No retry.                                                                                                                                                           |
| `5xx`              | Bounded retry (`001` FR-029a); on exhaustion, `NETWORK_FAILURE` (40).                                                                                 | Bounded retry; on exhaustion, `NETWORK_FAILURE` (40) **before** anonymizing or transmitting (never proceed with an unknown destination — spec edge case).                                                                          |
| malformed body     | `GENERIC_FAILURE` (1), contract drift.                                                                                                                | `GENERIC_FAILURE` (1), contract drift.                                                                                                                                                                                             |

**Key invariant**: `409 org_required` is exit **0** for `whoami` (it is a reported state) but exit **12 (`ORG_REQUIRED`)** for `upload` (it is a hard gate — upload cannot proceed without a destination). This is the single response whose exit code differs by call site (R-3, spec edge case).

---

## `--json` output

- `poppi whoami --json` (FR-026): the `001` `WhoamiResultOk` gains an **additive** `organization` field — the org object (`id`, `name`, `slug`, `member_count`, `role`) on member, or `null` on no-Membership. See `command-output.schema.json`.
- `poppi upload --json` (FR-030): the `001` `upload-start` NDJSON event gains an **additive** `organization` object (`id`, `slug`). Strictly additive; no existing field changes.

---

## Mid-upload revocation (`401`/`403` after resolution)

If a subsequent cloud call returns `401`/`403` after `GET /api/orgs/me` resolved but before the batch completes (Membership revoked mid-upload, FR-031 / R-8): `upload` exits `AUTH_FAILURE` (10), preserves the `001` resume state, and instructs the user to verify access and re-run. No partial-success downgrade.

---

## Contract testing

1. **Happy path (member)** — `200` body parses; `whoami` names org + role; `upload` carries the destination forward.
2. **`409 org_required`** — two assertions: `whoami` exits 0 with the no-org message; `upload` exits `ORG_REQUIRED` (12) with the gate message and (mock-server) zero upload-endpoint hits (SC-008).
3. **No auth** — `401` → `AUTH_FAILURE` (10) for both commands.
4. **Malformed body** — `GENERIC_FAILURE` (1) (SC-006).

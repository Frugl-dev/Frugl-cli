# Handoff HTTP Boundary (consumed by frugl-cli 006)

**Feature**: 006-cli-web-session-handoff | **Date**: 2026-06-06 | **Status**: contract surface

Consumer expectations the CLI places on the cloud, in the same style as
`specs/001-cli-ingest-client/contracts/cloud-api.md`. **Any change here MUST be coordinated
with the cloud repo (`../frugl`)**, where issuance, redemption, session creation, and
deep-link preservation are implemented.

Common headers and status semantics from 001 `cloud-api.md` apply, with one deliberate
exception: because handoff is a post-success convenience, **no status — including 426 — may
change the upload's outcome or exit code** (spec FR-008, research R-7).

---

## `POST /api/auth/handoff`

Mint a single-use browser sign-in code for the authenticated CLI user.

**Auth**: `Authorization: Bearer <token>` (the CLI's existing session). Unauthenticated →
`401` (FR-004).

**Request body**:

```json
{ "redirect_to": "/dashboard/uploads/mfst_xxx" }
```

`redirect_to` MUST be a relative path (`/...`, not `//...`, no scheme/host). The cloud MUST
reject anything else with `400` — this is the open-redirect guard.

**Success response** (`201 Created`):

```json
{ "code": "hof_9f2c…", "expires_at": "2026-06-06T12:01:00.000Z" }
```

**Grant invariants** (cloud obligations, spec FR-002/003/009/012):

| Invariant   | Requirement                                                                       |
| ----------- | --------------------------------------------------------------------------------- |
| Entropy     | Opaque, unguessable, ≥ 128 bits; NOT a JWT; reveals nothing about the CLI token   |
| Single-use  | First successful redemption invalidates permanently                               |
| TTL         | Default 60 s from issuance; expiry server-tunable without CLI changes             |
| Binding     | Bound at mint to `(user_id, redirect_to)`; redeemable for exactly that pair       |
| Audit       | Issued / redeemed / expired-unredeemed are observable events                      |

**CLI behavior on each status** (all degrade to the plain dashboard URL; none retried,
none change exit code):

| Status                         | Meaning                            | `handoff.reason` in JSON |
| ------------------------------ | ---------------------------------- | ------------------------ |
| `201`                          | Grant minted                       | — (`active: true`)       |
| `400`                          | Invalid `redirect_to`              | `rejected`               |
| `401` / `403`                  | Token invalid mid-run              | `rejected`               |
| `404` / `405`                  | Endpoint not deployed (older cloud)| `unsupported`            |
| `426`                          | Version gate                       | `unavailable`            |
| `429` / `5xx` / network / timeout (3 s) | Transient                 | `unavailable`            |

---

## Redemption (web app obligation — not called by the CLI)

The CLI appends the code to the dashboard URL it prints:

```text
https://<endpoint>/dashboard/uploads/mfst_xxx?handoff=hof_9f2c…
```

When a browser requests any app URL carrying `?handoff=<code>`, the web app MUST:

1. **Valid code** (unexpired, unredeemed, `redirect_to` matches the requested path):
   establish a browser session for the bound user (Supabase session cookie, set
   server-side per constitution Principle III), mark the code redeemed, and `302` to the
   same URL with the `handoff` parameter removed (FR-006).
2. **Invalid / expired / redeemed code**: create no session from it, strip nothing
   silently — fall through to the standard login flow with the requested path preserved as
   the post-login destination (FR-007). No confusing error page.
3. **Existing session, same user**: discard the code (or redeem-and-ignore) and serve the
   page; never double-prompt (spec edge case).
4. **Existing session, different user**: never silently replace the session; surface an
   account choice with "keep current session" as the default (spec edge case).

The query parameter name `handoff` is part of this contract.

---

## CLI output contract (additive to 001 `command-output.schema.json`)

The `upload` final-summary JSON gains an optional `handoff` property; `dashboardUrl`
carries the query parameter only when `handoff.active === true`. Shapes and presence rules
in `../data-model.md`. Dry-run and no-op summaries never carry a code.

## Drift sentinel

Request and response shapes above are mirrored as zod schemas in `src/cloud/schemas.ts`
(`handoffRequestSchema`, `handoffResponseSchema`). `Schema.parse()` failure on a live
response degrades the handoff (reason `unavailable`) rather than failing the run — the
Principle VI honest-failure posture scoped to a convenience feature.

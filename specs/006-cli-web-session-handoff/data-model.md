# Data Model: CLI-to-Web Session Handoff

**Feature**: 006-cli-web-session-handoff | **Date**: 2026-06-06

Internal entity shapes on the CLI side. Wire shapes live in `contracts/handoff-api.md` and
are mirrored as zod schemas in `src/cloud/schemas.ts`. The CLI persists **nothing** for this
feature (research R-9); every entity below is in-memory for the duration of one `upload` run.

## HandoffPreference (resolved flag state)

The tri-state `--handoff` / `--no-handoff` / unset flag resolved against the run's
interactivity (research R-5).

| Field    | Type                  | Notes                                       |
| -------- | --------------------- | ------------------------------------------- |
| `active` | `boolean`             | Whether issuance will be attempted          |
| `source` | `"flag" \| "default"` | Mirrors the `PrLinkingSummary.source` idiom |

**Resolution rules** (in precedence order):

1. `--no-handoff` → `{ active: false, source: "flag" }`
2. `--handoff` → `{ active: true, source: "flag" }`
3. unset → `{ active: isTTY && mode === "text", source: "default" }`

`--dry-run` and the no-op (nothing to upload) path never attempt issuance regardless of
preference — there is no real dashboard destination to bind a code to.

## HandoffRequest (wire, CLI → cloud)

| Field         | Type     | Validation                                                                                                                              |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_to` | `string` | Relative path: MUST start with `/`, MUST NOT start with `//`, no URL scheme. Derived as `pathname + search` of the final dashboard URL. |

## HandoffGrant (wire, cloud → CLI)

| Field        | Type     | Validation                                                               |
| ------------ | -------- | ------------------------------------------------------------------------ |
| `code`       | `string` | `min(1)`; opaque — the CLI never parses or logs it beyond URL decoration |
| `expires_at` | `string` | `min(1)` ISO datetime; used only for the human hint                      |

Cloud-side invariants bound to the grant (single-use, TTL, user binding, audit) are contract
obligations, not CLI state — see `contracts/handoff-api.md`.

## HandoffResult (in-memory, returned by `requestHandoffUrl`)

The single value the `upload` command consumes. Total function of (preference, grant |
failure) — never throws.

```text
HandoffResult =
  | { active: true,  dashboardUrl: string,  expiresAt: string }   // decorated URL
  | { active: false, dashboardUrl: string,  reason: HandoffSkipReason }  // plain URL
```

| `HandoffSkipReason`  | Meaning                                                      |
| -------------------- | ------------------------------------------------------------ |
| `"disabled-flag"`    | `--no-handoff`                                               |
| `"disabled-default"` | Non-interactive run, no explicit opt-in (FR-011)             |
| `"unsupported"`      | Cloud returned 404/405 — endpoint not deployed (older cloud) |
| `"unavailable"`      | Timeout, network error, 5xx, 426, zod parse failure          |
| `"rejected"`         | 4xx other than 404/405 (e.g. 400 invalid redirect, 401)      |

**State transitions**: none persisted. `active: true` results are terminal; the printed URL
is the only artifact. A consumed/expired code transitions state **cloud-side only**.

## Output-contract additions (additive to 001 `command-output.schema.json`)

Final-summary JSON for `upload` gains one optional property:

```json
"handoff": {
  "oneOf": [
    { "active": true,  "expiresAt": "<ISO datetime>" },
    { "active": false, "reason": "disabled-flag | disabled-default | unsupported | unavailable | rejected" }
  ]
}
```

- Present **only** when issuance was attempted (`active: true` / failure reasons) or
  explicitly disabled by flag (`disabled-flag`). Absent on the default-off path so existing
  `--json` consumers observe no change (research R-8).
- When `handoff.active === true`, the existing `dashboardUrl` property carries the
  `?handoff=<code>` query parameter; otherwise it is byte-identical to today's value.

## Relationships

```text
upload run
  └─ lastDashboardUrl (existing, from completeManifest)
       └─ HandoffPreference ──(active)──► POST /api/auth/handoff
                                             │ 200: HandoffGrant ──► HandoffResult{active:true}
                                             │ any failure ───────► HandoffResult{active:false}
                                             ▼
                              final summary { dashboardUrl, handoff? }
```

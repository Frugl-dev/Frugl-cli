# Phase 1 Data Model: frugl-cli org membership (`004-cli-org-join`)

**Feature**: 004-cli-org-join | **Date**: 2026-05-24

Entities the CLI manipulates internally for `frugl join` and the org-aware `whoami` / `upload` flows. Public contract shapes (what the CLI emits on stdout/stderr or sends to the cloud) live in `contracts/`; this file is the **internal** model and the `--json` result shapes.

This feature deliberately adds **no persistent local state** (spec Assumptions → "No new persistent local state"): nothing here is written to the OS keychain, the `frugl-ledger` `conf` namespace, or the `frugl-resume-state` `conf` namespace. Every entity below is **ephemeral** — constructed during a single command invocation and discarded when it returns. The cloud-owned entities (Organization, Membership, Invitation) are referenced but never redefined here; the cloud's `003` data-model is authoritative for them.

The `001` data-model entities (`AuthSession`, `Endpoint`, `ExitCode`, `CommandResult`, `ProgressEvent`, the upload pipeline entities) are reused unchanged; this document records only the **delta**.

---

## Cloud-owned entities (referenced, not redefined)

These are owned and defined by cloud spec `003-org-membership-permissions`. The CLI only ever **reads** them via `GET /api/orgs/me` / `POST /api/join` and prints server-returned fields verbatim. It never creates, mutates, or enumerates them locally.

| Entity           | Owner       | CLI's relationship                                                                                                                      |
| ---------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Organization** | cloud (003) | Read-only. Identified to the user by `name` + `slug`. The CLI never creates one (web-only in v1) or sends `org_id`.                     |
| **Membership**   | cloud (003) | Read-only. Carries the caller's `role` (`owner \| admin \| member`). The CLI prints `role` verbatim, never reinterprets.                |
| **Invitation**   | cloud (003) | Never seen as an entity. The CLI holds only the transient plaintext **code** (see `InviteCode` below); the server hashes + looks it up. |

---

## Entity catalogue (CLI-side, all ephemeral)

### 1. `InviteCode`

The transient redemption material supplied as the `frugl join` positional argument. Lives only for the duration of the command; never persisted, never logged at default level (R-11 / FR-006).

| Field        | Type     | Source                  | Notes                                                                              |
| ------------ | -------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `raw`        | `string` | the positional argument | exactly as typed/pasted, before normalization                                      |
| `normalized` | `string` | `normalize(raw)` (R-10) | uppercase, whitespace/separator/non-Crockford stripped; the value sent on the wire |

**Validation** (`src/join/validate.ts`, FR-005): after normalization, `normalized` MUST match the base32-Crockford alphabet (`[0-9A-Z]` excluding `I`, `L`, `O`, `U`) and fall within the documented length bounds. A failure is rejected locally with **no network request** → `USAGE` (2).

**Privacy invariant (SC-005 / FR-006)**: neither `raw` nor `normalized` is ever written to stdout/stderr at the default log level, nor into any structured `--json` output. Only the `POST /api/join` request body carries it. `--debug` MAY include it, with a docs warning.

**State**: `(argument) --normalize()--> normalized --validate()--> (valid → POST body) | (invalid → USAGE, no network)`.

---

### 2. `JoinOutcome`

The internal result of `redeemCode()` in `src/cloud/join.ts` after `zod`-parsing the `POST /api/join` response. A discriminated union so the command renders one message + one exit code per case (R-4).

```ts
type JoinOutcome =
  | { kind: "joined"; org: OrgSummary; membership: MembershipSummary } // 200
  | { kind: "already-member"; orgName: string } // 409 already_member → exit 0 (R-2)
  | { kind: "wrong-org"; currentOrgName: string; targetOrgName: string } // 409 wrong_org
  | { kind: "code-rejected"; reason: "not_found" | "expired" | "revoked" | "exhausted" }
  | { kind: "rate-limited"; retryAfterSeconds: number }; // 429
```

```ts
interface OrgSummary {
  id: string;
  name: string;
  slug: string;
}

interface MembershipSummary {
  id: string;
  role: "owner" | "admin" | "member"; // printed verbatim (FR-019)
  joinedAt: string; // ISO 8601
}
```

Auth (`401`), version-gate (`426`), schema-mismatch (contract drift), and transient (`5xx`) failures are NOT modelled here — they are thrown by the shared client as the existing `001` typed errors (`AuthError`, `VersionGateError`, `GENERIC_FAILURE` ZodError wrap, `NetworkError`), so they exit with their already-contracted codes (R-1/R-6).

**Invariant**: `kind: "already-member"` is the only non-`joined` variant that maps to exit **0** (R-2 / FR-017). `role` is whatever the server returned — the CLI does not enumerate or validate the role set beyond the zod enum (the enum mirrors the cloud's documented `owner | admin | member`).

---

### 3. `OrgContext`

The `{ org, role }` resolved from `GET /api/orgs/me` for the duration of a single `whoami` or `upload` invocation (R-3 / R-7). Ephemeral — re-resolved every run so a server-side role/org change is reflected next invocation (spec Key Entities; no stale cache).

`getOrgContext()` in `src/cloud/orgs.ts` returns:

```ts
type OrgContext =
  | {
      kind: "member";
      org: OrgContextOrg;
      membership: { role: "owner" | "admin" | "member"; joinedAt: string };
    }
  | { kind: "none" }; // GET /api/orgs/me → 409 org_required
```

```ts
interface OrgContextOrg {
  id: string;
  name: string;
  slug: string;
  memberCount: number; // from member_count (FR-024)
  createdAt: string; // ISO 8601
}
```

**Behaviour by call site**:

- `whoami` (FR-024/025): `kind: "member"` → report org name+slug+memberCount+role, exit 0; `kind: "none"` → "no org yet" + remedies, **exit 0**.
- `upload` (FR-027/028): `kind: "member"` → carry `{ org, role }` into the summary + `upload-start` event; `kind: "none"` → `ORG_REQUIRED` gate, exit 12, no discovery/anonymize/transmit (fires for `--dry-run` too).

A `401` is thrown as `AuthError` from the wrapper (shared `001` behaviour); only `org_required` is modelled as the `none` data variant (R-3).

**Validation**: `zod` schema in `src/cloud/schemas.ts`; a body that matches neither the `200` success shape nor the `409 org_required` shape is a contract violation → `GENERIC_FAILURE` (FR-012 / SC-006).

---

### 4. `JoinResult` (`--json` output for `frugl join`)

Structured form of the single stdout JSON object emitted by `frugl join --json` (FR-021). Public contract — see `contracts/command-output.schema.json`. Slots into the `001` FR-040 uniform machine contract alongside `login`/`logout`/`whoami`.

```ts
type JoinResult =
  | {
      command: "join";
      ok: true;
      organization: { id: string; name: string; slug: string };
      membership: { id: string; role: "owner" | "admin" | "member"; joinedAt: string };
    } // 200 OR 409 already_member (both ok:true, exit 0 per R-2)
  | {
      command: "join";
      ok: false;
      error:
        | "wrong_org"
        | "not_found"
        | "expired"
        | "revoked"
        | "exhausted"
        | "rate_limited"
        | "validation_failed"
        | "unauthorized"
        | "upgrade_required";
      message: string;
      details?: Record<string, unknown>; // e.g. { current_org_name, target_org_name } for wrong_org; { retry_after_seconds } for rate_limited
    };
```

**Invariant**: `ok: false` shapes still exit with the documented exit code from the R-4 mapping; the JSON body is for tool consumption, the exit code is for shell consumption (mirrors `001` `CommandResult` invariant). The `already_member` case is rendered as `ok: true` (it is a success from the user's perspective, R-2). The plaintext `code` is NEVER present in this object (SC-005 / FR-006).

---

### 5. Extension to `WhoamiResultOk` (`--json` output for `frugl whoami`)

`frugl whoami --json` extends its existing `001` `WhoamiResultOk` object with one **additive** field (FR-026 / R-12). No existing field is renamed or removed.

```ts
// 001 WhoamiResultOk, with the additive field:
{
  command: "whoami";
  ok: true;
  email: string;
  userId: string;
  endpoint: string;
  loggedInAt: string;
  organization:                                  // NEW (FR-026), additive
    | { id: string; name: string; slug: string; member_count: number; role: "owner" | "admin" | "member" }
    | null;                                       // null when the caller has no Membership
}
```

**Invariant**: `organization` is the org object on `kind: "member"`, `null` on `kind: "none"`. Both are `ok: true`, exit 0 (FR-025). The not-logged-in case is the unchanged `001` `WhoamiResultNotLoggedIn` (`ok: false`, exit `AUTH_FAILURE`).

---

### 6. Extension to the `upload-start` progress event (`--json` output for `frugl upload`)

The `001` `upload-start` NDJSON event gains one **additive** field (FR-030 / R-12). The `001` progress-event schema's forward-compatibility note already requires consumers to tolerate unknown fields, so this is backward-compatible.

```ts
// 001 upload-start event, with the additive field:
{
  event: "upload-start";
  seq: number;
  ts: string;
  manifestId: string;
  expectedSessionCount: number;
  redactionPolicyVersion: string;
  endpoint: string;
  organization: {
    id: string;
    slug: string;
  } // NEW (FR-030), additive — only id + slug
}
```

**Invariant**: `organization` is present on every `upload-start` event because the org-gate (R-7) guarantees a resolved member context before any upload begins — a no-org run never reaches `upload-start` (it exits at the `ORG_REQUIRED` gate). Only `id` + `slug` are emitted here (the event is a terse machine signal; the full org object is in the human summary and in `whoami`).

---

### 7. Extension to `ExitCode`

Four additions to the `001` frozen `EXIT` table (`src/lib/exit-codes.ts`). Public contract — see `contracts/exit-codes.md`. Claims next-available numbers in the `001`-reserved gaps; no existing code is reassigned (R-9 / FR-032/033).

```ts
// additions to the 001 EXIT constant:
export const EXIT = {
  // ... all 001 codes unchanged (OK=0 … INSPECT_DIR_EXISTS=60) ...
  ORG_REQUIRED: 12, // authenticated but no Membership; emitted by `frugl upload` only (FR-028)
  JOIN_CODE_REJECTED: 70, // not_found / expired / revoked / exhausted (FR-016)
  ALREADY_IN_OTHER_ORG: 71, // wrong_org one-org-per-user conflict (FR-018)
  RATE_LIMITED: 72, // redemption rate-limit tripped, 429 (FR-014)
} as const;
```

**Invariant**: every documented failure mode in this spec maps to exactly one code; no two share a code; SC-003/SC-006/SC-008 are enforced by tests that drive each path and assert the code. `whoami`'s no-org state does NOT use `ORG_REQUIRED` — it exits 0 (FR-025).

---

## Typed error classes (extension to `src/lib/errors.ts`)

Mirrors the `001` pattern: one class per failure mode, each carrying its `EXIT` code so the top-level command handler maps thrown errors to exit codes uniformly.

| Class               | Exit code                   | Thrown when                                                                                                          |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `OrgRequiredError`  | `ORG_REQUIRED` (12)         | `upload` resolves `OrgContext.kind === "none"` (FR-028)                                                              |
| `JoinRejectedError` | `JOIN_CODE_REJECTED` (70)   | `not_found` / `expired` / `revoked` / `exhausted` (FR-016) — carries the sub-`reason` for the `--json` `error` field |
| `WrongOrgError`     | `ALREADY_IN_OTHER_ORG` (71) | `wrong_org` (FR-018) — carries `currentOrgName` / `targetOrgName`                                                    |
| `RateLimitedError`  | `RATE_LIMITED` (72)         | `429 rate_limited` (FR-014) — carries `retryAfterSeconds`                                                            |

Reused unchanged from `001`: `AuthError` (10, for `401`), `VersionGateError` (50, for `426`), `NetworkError` (40, transient exhaustion), and the ZodError→`GENERIC_FAILURE` (1) contract-drift wrap.

---

## Where validation lives (delta from `001`)

| Surface                                              | Tool                            | File                    |
| ---------------------------------------------------- | ------------------------------- | ----------------------- |
| `POST /api/join` success + typed-error bodies        | `zod` runtime validation        | `src/cloud/schemas.ts`  |
| `GET /api/orgs/me` success + `409 org_required`      | `zod` runtime validation        | `src/cloud/schemas.ts`  |
| Invite-code alphabet + length (pre-network)          | pure functions                  | `src/join/validate.ts`  |
| Invite-code normalization (pre-network)              | pure functions                  | `src/join/normalize.ts` |
| `frugl join` positional-arg shape (required, single) | oclif args system + strict-args | `src/commands/join.ts`  |

All schema mismatches surface as honest failures with a stable exit code (`GENERIC_FAILURE`); never silently coerced (Principle VI / FR-012).

---

## Relationships

```
frugl join <code>
  InviteCode.raw ──normalize()──> InviteCode.normalized ──validate()──┐
                                          (USAGE if invalid, no network)
                                                                       ▼
                                            redeemCode() ──POST /api/join──> JoinOutcome
                                                                                  │
                                                          ┌───────────────────────┤
                                                          ▼                       ▼
                                              JoinResult (--json)         message + exit code (R-4)

frugl whoami / frugl upload (org-aware)
  getOrgContext() ──GET /api/orgs/me──> OrgContext { kind: "member" | "none" }
        │
        ├── whoami:  member → report org+role (exit 0) | none → "no org yet" (exit 0)
        │            (--json) extends WhoamiResultOk.organization (obj | null)
        │
        └── upload:  none → ORG_REQUIRED gate (exit 12, 0 bytes, before discover/anonymize)
                     member → { org, role } ──> summary line (FR-029) + upload-start.organization (FR-030)
```

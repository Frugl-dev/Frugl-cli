# Research: CLI-to-Web Session Handoff

**Feature**: 006-cli-web-session-handoff | **Date**: 2026-06-06 | **Status**: decisions locked

Phase 0 decision log. Everything not already fixed by `spec.md` is resolved here. The
cloud-side mechanics (code minting, redemption, Supabase session creation) are recorded
as **consumer expectations** — they bind the cloud repo (`../frugl`) via
`contracts/handoff-api.md`, mirroring how `001-cli-ingest-client` records its cloud surface.

---

## R-1: Separate issuance endpoint, not a decorated `/complete` response

**Decision**: The CLI mints the handoff code via a dedicated authenticated call,
`POST /api/auth/handoff`, made *after* `POST /api/uploads/{id}/complete` succeeds. The
`/complete` response stays untouched.

**Rationale**:

- `/complete` is documented idempotent ("calling twice with the same body returns the same
  response", 001 `contracts/cloud-api.md`). A single-use code embedded in its response would
  break that contract — a retried complete would either re-mint (not idempotent) or return a
  consumed code (broken link).
- Opt-out (spec FR-010/011) means *no code is ever minted*; that is only expressible if
  issuance is a separate call the CLI can skip.
- Failure isolation (spec FR-008): a failed convenience call after a successful upload is
  trivially swallowed when it is its own request; entangling it with `/complete` would put
  the upload's success path at risk.

**Alternatives considered**:

- *Cloud returns a handoff-ready `dashboard_url` from `/complete`* — rejected per above
  (idempotency, opt-out, blast radius).
- *CLI mints a Supabase magic link* — rejected; the CLI deliberately does not embed
  `@supabase/supabase-js` (001 research R-8) and must never hold the service-role key
  (constitution Principle III).

## R-2: Request/response shape — server derives nothing from the URL

**Decision**: Request body is `{ "redirect_to": "<relative dashboard path>" }` where the CLI
passes the *path component* of the dashboard URL it received from `/complete` (e.g.
`/dashboard/uploads/mfst_xxx`). Response is `{ "code": "<opaque>", "expires_at": "<ISO>" }`.
The CLI appends `?handoff=<code>` to the absolute dashboard URL it already prints.

**Rationale**:

- Binding the code to a server-validated **relative** path (must start with `/`, no scheme,
  no host) forecloses open-redirect abuse; the cloud rejects absolute or protocol-relative
  values with `400`.
- The CLI never invents dashboard paths (it already treats `dashboard_url` as
  server-authored); passing back the same path keeps one source of truth.
- `expires_at` lets the CLI print an honest hint (e.g. "link signs you in for ~60s") without
  hardcoding the TTL client-side (spec assumption: TTL tunable by cloud without CLI changes).

**Alternatives considered**:

- *Request carries `manifest_id` and the server re-derives the path* — workable, but couples
  the auth endpoint to upload semantics; `redirect_to` keeps `/api/auth/handoff` reusable for
  future deep links (e.g. recommendations) without a contract change.
- *Code in URL fragment (`#handoff=`)* — fragments don't reach the server, forcing a
  client-side JS exchange before SSR can render; query param + server-side redemption with a
  clean-URL redirect is simpler and keeps the code out of the rendered page.

## R-3: Query parameter name and URL handling

**Decision**: Query parameter is `handoff`. The CLI uses `URL` to append it
(`url.searchParams.set("handoff", code)`) so existing query strings survive. On redemption
the web app 302s to the same URL with the parameter stripped (spec acceptance 1.3).

**Rationale**: `new URL()` is already the dashboard-URL mechanism in
`src/upload/cloud-http-adapter.ts:98-101`; `searchParams.set` is encoding-safe.

## R-4: Code properties (consumer expectations on the cloud)

**Decision** (recorded as contract, enforced cloud-side):

- Opaque, unguessable, ≥ 128 bits entropy; not a JWT, not derived from or revealing the
  CLI's access/refresh token (spec FR-009).
- Single-use: first successful redemption invalidates (FR-002); default TTL 60 s (FR-003).
- Bound at mint time to `(user_id, redirect_to)`; redemption creates a browser session for
  exactly that user and redirects to exactly that path (FR-006).
- Expired/used/unknown code → no session, fall through to login with deep link preserved
  (FR-007); issuance and redemption are auditable events (FR-012).

**Rationale**: These are the spec's FRs translated to the wire boundary; the CLI cannot test
them directly but the contract doc makes them a coordinated cross-repo obligation, same
mechanism as 001's `cloud-api.md`.

## R-5: Flag surface and non-interactive default

**Decision**: One oclif boolean flag on `upload`: `handoff`, declared with
`allowNo: true` and **no default**, yielding `--handoff` / `--no-handoff`. Effective value:

1. `--no-handoff` → off (explicit opt-out, FR-010)
2. `--handoff` → on (explicit opt-in, e.g. JSON consumers that want it, FR-011)
3. Neither: on when the run is interactive (`process.stdout.isTTY` and output mode is
   `text`), off otherwise (`--json`, piped stdout, CI) — FR-011's safe default.

**Rationale**: Mirrors the repo's existing tri-state precedence idiom
(`resolveEffectiveLinkPrs` in `src/upload/upload-output.ts:81-88`: flag > config > default).
No persisted config key in v1 — there is no evidence yet that anyone wants a sticky
per-machine default, and adding one later is additive.

**Alternatives considered**: `FRUGL_NO_HANDOFF` env var — deferred; flags + TTY default
cover the CI case (CI is non-TTY, so it is already off by default).

## R-6: Where the code lives in `src/`

**Decision**: A new, self-contained `src/cloud/handoff.ts` exporting
`requestHandoffUrl(client, dashboardUrl, opts) → Promise<HandoffResult>`: derives
`redirect_to` from the dashboard URL, calls `client.call()` with the new zod schema, appends
the query param, and maps **every** failure to a `{ active: false, reason }` result instead
of throwing. `src/commands/upload.ts` calls it once, after the per-source pipeline loop, on
the final `lastDashboardUrl`.

**Rationale**:

- `UploadCloudPort` (src/upload/cloud-port.ts) stays untouched: handoff is not part of the
  per-session upload lifecycle, and widening the port would force the in-memory test adapter
  and the deep module to know about an auth concern.
- A single seam function keeps FR-008 (never fail the upload) enforceable in one place and
  unit-testable without the pipeline.
- Schemas go in `src/cloud/schemas.ts` beside every other wire shape (zod drift sentinel,
  Principle VI).

## R-7: Bounded wait and failure taxonomy

**Decision**: `timeoutMs: 3_000`, **zero retries** (not even the FR-029a transient set).
Any failure — timeout, 4xx/5xx, 404 (endpoint absent on older cloud), 426 version gate,
network error, zod parse error — degrades identically: plain URL printed, exit code
unchanged, and the failure surfaced as one dim stderr line in text mode /
`handoff: { active: false, reason }` in JSON (Principle VI: no silent catches; spec FR-008:
informational only).

**Rationale**: The upload has already succeeded; retrying a convenience call trades user
latency for nothing (a fresh code is one command away). 3 s is far below the SC-005
"no perceptible delay" ceiling given the summary already follows network completion. A 426
here must not fail the run — the version-gate exit (50) is reserved for gates that block the
*requested operation*, which has already completed.

## R-8: Output contract changes (additive, FR-036-compatible)

**Decision**: In the final-summary JSON (and dry-run/no-op variants untouched —
they never mint codes):

- `dashboardUrl` carries the `?handoff=` URL when handoff is active, plain URL otherwise.
- New optional sibling `handoff`:
  `{ active: true, expiresAt: string } | { active: false, reason: string }`, present only
  when issuance was attempted or explicitly disabled by flag (absent ⇒ default-off path,
  preserving byte-for-byte output for existing non-interactive consumers).

Human (text) output: the existing dashboard-link line prints the decorated URL plus a dim
expiry hint; on degradation, the plain URL plus one dim "(sign-in link unavailable — log in
on the web)" note.

**Rationale**: 001 froze the contract surface but explicitly allows additive evolution;
default-off in JSON mode (R-5) means existing `--json` pipelines see zero diff unless they
opt in.

## R-9: No new persistence

**Decision**: The CLI never stores handoff codes — not in keychain, not in `conf`
namespaces, not in resume state. The code exists only in memory and in the printed URL.

**Rationale**: A ≤ 60 s single-use credential has no resume value; persisting it would only
widen the audit surface of a public OSS binary (Principle II/VI posture).

## R-10: Testing strategy

**Decision**: Three tiers, matching 001 conventions (co-located `*.test.ts`, vitest):

- **Unit** — `handoff.test.ts`: effective-flag precedence (R-5 truth table), `redirect_to`
  derivation (path+query only, never host), URL decoration, every failure class → degraded
  result, 3 s timeout honored, no throw escapes.
- **Contract** — zod round-trip of `handoff` request/response fixtures in
  `src/cloud/schemas.ts` (drift sentinel), including rejection of absolute `redirect_to`.
- **Integration** — extend the Docker-stack loop (001 SC-004): upload with handoff on,
  assert `?handoff=` present and `GET` of the link lands on the dashboard authenticated;
  second `GET` falls to login; post-TTL `GET` falls to login with deep link preserved.
  Lands only once the cloud side exists; tracked as a cross-repo task.

---

All NEEDS CLARIFICATION items from the Technical Context: **none remained** (the spec's
Assumptions section pre-resolved TTL, scope, and non-interactive defaults).

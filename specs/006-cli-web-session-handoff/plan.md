# Implementation Plan: CLI-to-Web Session Handoff

**Branch**: `027-cli-web-session-handoff` | **Date**: 2026-06-06 | **Spec**: [./spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-cli-web-session-handoff/spec.md`

## Summary

After a successful `frugl upload`, the CLI mints a single-use, ~60 s handoff code from a new
authenticated cloud endpoint (`POST /api/auth/handoff`) and appends it as `?handoff=<code>`
to the dashboard URL it already prints; the web app redeems the code into a browser session
and redirects to the clean URL, so the user is never asked to log in twice. The CLI-side
approach is one new self-contained module (`src/cloud/handoff.ts`) called once after the
upload pipeline completes, a tri-state `--handoff`/`--no-handoff` flag defaulting to
on-when-interactive / off-when-non-interactive, total-function degradation (any failure →
plain URL, unchanged exit code), and strictly additive output-contract changes. Issuance,
redemption, session creation, and deep-link preservation are cloud/web obligations recorded
as consumer expectations in `contracts/handoff-api.md` and implemented in the sibling
`frugl/` repo.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js ≥ 20 — unchanged from 001.

**Primary Dependencies**: No new dependencies. Reuses `@oclif/core` (flag surface), `zod`
(wire schemas in `src/cloud/schemas.ts`), native `fetch` via the existing `CloudClient`
(`src/cloud/client.ts`) with its `Authorization`/`X-Frugl-Client` headers and timeout
support. `p-retry` is deliberately **not** applied to the handoff call (research R-7).

**Storage**: None. Handoff codes are never persisted — not keychain, not `conf`, not resume
state (research R-9). No changes to the two existing `conf` namespaces.

**Testing**: vitest, co-located `*.test.ts` (repo convention). Unit (flag precedence,
`redirect_to` derivation, URL decoration, every failure class → degraded result), contract
(zod round-trip of handoff fixtures), integration (Docker-stack loop once the cloud side
lands; cross-repo task). See research R-10.

**Target Platform**: macOS / Windows / Linux, Node ≥ 20 — unchanged.

**Project Type**: Single-package CLI (oclif) — unchanged.

**Performance Goals**: SC-005 — handoff adds no perceptible delay: one extra HTTP round
trip after `/complete`, hard-capped at 3 000 ms with zero retries; typical broadband cost
< 300 ms. Upload throughput goals from 001 (SC-003/003a) are untouched — the call happens
after the pipeline finishes.

**Constraints**:

- **Never harm the upload** (spec FR-008): issuance failure of any kind — including 426 —
  must not change exit code, output `ok` status, or resume/ledger state.
- **Privacy posture** (001 FR-034/035): the handoff call is a direct consequence of a
  user-invoked command; no new background activity, no telemetry.
- **Output contract** (001 FR-036): changes are strictly additive — optional `handoff`
  object, `dashboardUrl` decorated only when active; default-off in non-interactive mode
  keeps existing `--json` consumers byte-identical (research R-8).
- **Credential hygiene** (spec FR-009): the code is opaque, single-use, ≤ 60 s, distinct
  from the CLI token; printed output never contains a long-lived credential.

**Scale/Scope**: One new endpoint consumed, one new flag, one new module + tests, ~4 files
touched in `src/`. Cloud-side scope (endpoint, redemption route, audit) lives in `../frugl`
against this same spec.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

The applicable constitution is **Frugl Cloud Constitution v2.1.0** at
`../frugl/.specify/memory/constitution.md` (the local `.specify/memory/constitution.md` is a
placeholder).

| Principle                                                                | Applies | Gate evaluation                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **I. Waste-Reduction Orientation**                                       | yes (indirectly) | The dashboard is where waste levers get pulled; today's forced re-login is friction between ingest and insight. Removing it increases the rate at which uploads convert into reviewed sessions. No new non-waste surface is added. ✅ **Pass**                                                                                                              |
| **II. Multi-Tenant by Construction**                                     | yes     | The code is minted server-side against the bearer session, bound to `(user_id, redirect_to)`, single-use, ≤ 60 s, ≥ 128-bit entropy (contract). The CLI holds it in memory only and never persists it. Redemption yields a normal Supabase session subject to RLS — no isolation layer is bypassed or weakened. Cross-user redemption must be covered by the cloud's authorization tests. ✅ **Pass** |
| **III. Astro + React Islands + Supabase Auth**                           | partial | Supabase Auth remains the only identity provider: the handoff code is a *delivery mechanism* for an ordinary Supabase browser session, created server-side in the Astro app; the service-role key stays server-side; the CLI still does not embed `@supabase/supabase-js` (001 research R-8 upheld). ✅ **Pass**                                                          |
| **IV. shadcn Primitives + Semantic Tokens**                              | n/a     | No CLI UI surface; the web login-wall touch-ups are governed in `../frugl`. ✅ **N/A**                                                                                                                                                                                                                                                                                     |
| **V. Pre-Commit Gates + Local Parity**                                   | yes     | No toolchain change; oxlint/oxfmt/tsc/vitest gate applies to the new module. Local parity: the handoff loop (mint → redeem → dashboard) must work against the Docker stack with zero external credentials; integration coverage is the cross-repo task in research R-10. ✅ **Pass**                                                                                       |
| **VI. Fail-Closed Anonymization, IaC Source-of-Truth, Honest Failures**  | yes     | • Anonymization — N/A: no session bytes touched; the only new outbound payload is a server-authored relative path. ✅ • IaC — N/A: no AWS resources owned by the CLI. ✅ • Honest failures — degradation is explicit, never silent: every failure is surfaced (dim stderr note in text, `handoff:{active:false,reason}` in JSON) while honoring spec FR-008's "informational only" mandate; zod parse failure on the response degrades rather than crashes, and the schemas remain the cross-repo drift sentinel. ✅ **Pass** |
| **VII. Canonical Session Shape + Raw-Backup Pipeline**                   | n/a     | No session data, raw objects, or canonical schema involved. ✅ **N/A**                                                                                                                                                                                                                                                                                                     |

**Result**: No constitutional violations. No Complexity Tracking entries required.

**Post-Phase-1 re-check**: The design (research R-1..R-10, data-model, contracts) introduces
no new gate concerns. The one judgment call — swallowing a 426 on the handoff call (research
R-7) — is an *honest* degradation, not a silent one: the reason is surfaced, and the
version gate still hard-fails every operation that precedes it. Result still: ✅ **Pass**.

## Project Structure

### Documentation (this feature)

```text
specs/006-cli-web-session-handoff/
├── plan.md              # This file (/speckit-plan output)
├── spec.md              # Feature specification (authoritative)
├── research.md          # Phase 0 output — locked decisions R-1..R-10
├── data-model.md        # Phase 1 output — HandoffPreference/Grant/Result shapes
├── quickstart.md        # Phase 1 output — contributor / verifier walk-through
├── contracts/
│   └── handoff-api.md   # Phase 1 output — consumer expectations on the cloud
├── checklists/          # Pre-existing (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

Additions to the established 001 layout only — no new packages, no structural change:

```text
frugl-cli/
└── src/
    ├── cloud/
    │   ├── handoff.ts           # NEW — requestHandoffUrl(): redirect_to derivation,
    │   │                        #   client.call (3s timeout, no retry), URL decoration,
    │   │                        #   total-function degradation to HandoffResult
    │   ├── handoff.test.ts      # NEW — unit + contract fixtures (research R-10)
    │   └── schemas.ts           # MODIFIED — + handoffRequestSchema / handoffResponseSchema
    ├── commands/
    │   └── upload.ts            # MODIFIED — `handoff` flag (allowNo, no default);
    │                            #   resolve HandoffPreference; one requestHandoffUrl()
    │                            #   call after the per-source pipeline loop; thread
    │                            #   result into final summary + text output
    └── upload/
        └── upload-output.ts     # MODIFIED (if needed) — dashboard-line formatter gains
                                 #   the expiry hint / degradation note (pure formatter,
                                 #   keeps human/JSON parity rule intact)
```

**Structure Decision**: `src/cloud/handoff.ts` sits beside `client.ts`/`schemas.ts` because
it is purely an HTTP-boundary concern. `UploadCloudPort` (`src/upload/cloud-port.ts`) is
deliberately **not** widened: handoff is not part of the per-session upload lifecycle, and
keeping it out preserves the port's "nothing about HTTP leaks across" guarantee and leaves
the in-memory test adapter untouched (research R-6). The command remains the orchestrator;
formatting stays in the builders/formatters that already guarantee human/JSON parity.

### Cross-repo obligations (implemented in `../frugl`, bound by `contracts/handoff-api.md`)

- `POST /api/auth/handoff` — mint, with grant invariants (entropy, single-use, TTL,
  binding, audit) and `redirect_to` validation (open-redirect guard).
- Redemption middleware — valid code → Supabase session cookie + 302 to clean URL;
  invalid/expired/used → login wall with deep link preserved; same-user session → serve;
  different-user session → explicit account choice.
- Authorization tests per Principle II, and Docker-stack integration coverage per
  Principle V.

## Complexity Tracking

> No Constitution Check violations. Section intentionally empty.

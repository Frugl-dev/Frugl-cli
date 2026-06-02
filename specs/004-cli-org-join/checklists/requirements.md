# Specification Quality Checklist: frugl-cli org membership — `frugl join` + org-aware `whoami` / `upload`

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-23
**Updated**: 2026-05-24 (expanded scope: org-aware `whoami` + `upload`; reconciled to cloud 003 contracts)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Validation notes (2026-05-24 review)

**Content Quality**

- The spec keeps WHAT/WHY framing. References to specific cloud HTTP endpoints (`POST /api/join`, `GET /api/orgs/me`), the success/error response shapes, and proposed exit-code numbers are **cross-repo contract surface**, not implementation leakage — they are the negotiated interface this CLI consumes from `frugl/specs/003-org-membership-permissions/`, exactly as `001-cli-ingest-client` documents the upload/auth contracts it consumes. Library mentions are tied to the _existing_ `001` conventions, not new technical choices.
- The "Cross-repo context" section is explicitly informational and introduces no new product requirements.

**Requirement Completeness**

- 0 [NEEDS CLARIFICATION] markers. The scope forks that could have warranted clarification (CLI-side org creation; `frugl org` namespace; multi-org selection) are settled as v1 decisions in Assumptions / Out of Scope with explicit follow-up paths.
- Each of FR-001..FR-033 names an actor, an action, and a verifiable outcome.
- Contract reconciliation against cloud 003 applied: success shape is the nested `{org, membership}` form; `already_member` is `409` mapped to an exit-0 idempotent success (FR-017); `wrong_org` interpolates `details.current_org_name` / `details.target_org_name` (FR-018); invite entropy stated as ≥48 bits (matching cloud FR-012).

**Feature Readiness**

- Each P1 user story (US1–US5) carries an Independent Test stanza; the P2 story (US6) does too.
- SC-001 leads with the user-visible time-to-value (≤30s clipboard-to-joined), per Constitution Principle I.
- The org-awareness additions are guarded so they cannot regress `001`: `whoami` keeps exit 0 on the no-org state (FR-025); `upload`'s `--json` `upload-start` org field is strictly additive (FR-030); the new exit codes claim reserved-gap numbers and reassign nothing (FR-032).

## Notes

- This spec depends on the cloud-side `POST /api/join` and `GET /api/orgs/me` contracts in `frugl/specs/003-org-membership-permissions/`. Any change to those endpoints' error-code set or response shapes MUST trigger an update to FR-011..FR-018 and FR-024..FR-031 here (coordinated cross-repo bump).
- All items currently pass.

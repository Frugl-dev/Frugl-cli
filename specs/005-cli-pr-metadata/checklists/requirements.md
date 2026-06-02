# Specification Quality Checklist: frugl-cli PR-link metadata — opt-in per-session git context

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-24
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

- WHAT/WHY framing held. References to git concepts (remote, branch, commit, `origin`) are the domain vocabulary of the feature, not implementation choices; the manifest-schema reference is cross-repo contract surface (the same way `001`/`004` reference their contracts). No language/framework/library is prescribed.

**Requirement Completeness**

- 0 [NEEDS CLARIFICATION] markers. The two forks that could have warranted one are settled with privacy-first defaults rather than questions: (a) opt-in vs. default-on → opt-in, because repo identity is normally redacted (`001` FR-011); (b) real coordinates vs. a privacy hash → real host + `owner/name`, because the cloud must match a real GitHub PR and a hash would defeat the feature — made safe by credential-stripping (FR-005/FR-015) and mandatory pre-send auditability (FR-013/FR-014).
- FR-001..FR-016 each name an actor/trigger/outcome and are individually testable; every SC maps to an automated assertion (mock-server spy, fixture, schema test, network spy).

**Feature Readiness**

- Each P1 story (US1–US3) and the P2 story (US4) carries an Independent Test stanza.
- The feature is guarded so it cannot regress `001`: default-off is byte-for-byte unchanged (FR-001/FR-002, SC-001); git context is metadata outside the redacted payload so it cannot churn the incremental ledger (FR-011, SC-007); the manifest extension is strictly additive (FR-010, SC-006); dry-run still transmits nothing (FR-014, SC-004).

## Notes

- Producer side of cloud `frugl/specs/005-intelligence-post-processing` FR-024. The cloud consumer (GitHub OAuth + PR matching) is deferred on the cloud roadmap; this CLI ships the producer as forward-compat. Any change to the `gitContext` shape requires a coordinated cross-repo bump (FR-012).
- All items currently pass.

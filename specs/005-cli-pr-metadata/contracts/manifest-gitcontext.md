# Contract: Manifest `gitContext` extension (005-cli-pr-metadata)

**Feature**: 005-cli-pr-metadata | **Date**: 2026-05-24

This is the **public contract surface** for the opt-in per-session git metadata, extending the `001-cli-ingest-client` manifest contract. It is consumed by the cloud (`poppi/specs/005-intelligence-post-processing` FR-024) to link uploaded sessions to pull requests. Per `001` FR-036 and this feature's FR-012, these fields are a stable public contract: any **non-additive** change requires the coordinated cross-repo bump process with `poppi/005`.

The machine-readable schema fragment is [`manifest-entry.gitcontext.schema.json`](./manifest-entry.gitcontext.schema.json). This document is its narrative companion (mirroring the JSON-schema + markdown style of `001/contracts/`).

---

## 1. What is added, and where

A single **optional** property, `gitContext`, on the manifest's per-session `ManifestEntry` (`001` `manifest.schema.json` → `$defs.ManifestEntry`). Nothing else in the `001` manifest changes.

```jsonc
{
  "sessionId": "d3dae575-3ab7-463c-873f-8dfefb789a47",
  "identityDerivation": "native",
  "contentHash": "…64-hex sha256 of the REDACTED PAYLOAD…",
  "byteSize": 14821,
  "gitContext": {                       // ← OPTIONAL, ADDITIVE (FR-010)
    "repository": {
      "host": "github.com",
      "owner": "acme",
      "name": "widgets"
    },
    "branch": "005-cli-pr-metadata",    // omitted on detached HEAD (FR-006)
    "commitSha": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"
  }
}
```

On the **wire** (the manifest-create request body, `POST /api/uploads/manifest`), the per-session object carries the field as snake_case `git_context`, consistent with `001`'s existing `session_id` / `format_version` convention — and its inner keys are snake_case too: `{ repository: { host, owner, name }, branch?, commit_sha }` (note `commit_sha`, not `commitSha`). The CLI's `src/cloud/schemas.ts` `manifestEntryRequestSchema` gains an optional `git_context` of that snake_case shape. The camelCase form shown above (`gitContext` / `commitSha`) is the **public manifest/stdout contract** shape (the manifest object surfaced in the CLI's final-summary and `--json` output, and the schema fragment `manifest-entry.gitcontext.schema.json`); the snake_case form is only the HTTP request body. This camelCase-contract / snake_case-wire split is exactly the `001` convention (e.g. contract `manifestId` ↔ wire `upload_id`, contract `redactionPolicyVersion` ↔ wire `redaction_policy_version`).

---

## 2. Why it is strictly additive (FR-010, SC-006)

- `gitContext` is **optional**. Every `001`-era manifest (no `--link-prs`) is a valid `005` manifest with the property simply absent.
- No existing field is renamed, removed, retyped, or made required.
- The manifest's `additionalProperties: false` is preserved by **adding** the `gitContext` property to `ManifestEntry`'s declared properties — not by relaxing the constraint. (A consumer validating against the un-extended `001` schema with `additionalProperties: false` would reject the new field; the contract bump is exactly to add the property, which is the additive merge described in the schema fragment's `$comment`.)
- **Backward-compatibility test (SC-006)**: a consumer that ignores `gitContext` produces the same result for a `--link-prs` manifest as for a no-flag one. The progress-event/manifest consumers are already required to tolerate unknown fields (`001` `progress-event.schema.json` forward-compatibility note), so an additive field is non-breaking by `001`'s own contract rules.

---

## 3. Field semantics

| Field                 | Required within `gitContext` | Meaning                                                                                                  |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `repository.host`     | yes                          | Remote host only (`github.com`). Credential-stripped; never contains userinfo, scheme, or path (FR-005). |
| `repository.owner`    | yes                          | Owner/org segment of the `origin` path.                                                                  |
| `repository.name`     | yes                          | Repo name, trailing `.git` stripped.                                                                     |
| `branch`              | no                           | Work-time branch (prefers source-recorded; FR-006). **Omitted** on detached HEAD.                        |
| `commitSha`           | yes                          | Full 40-hex `HEAD` SHA at upload time (FR-007).                                                           |

**Presence rule (FR-008)**: `gitContext` is present on an entry **iff** `--link-prs` was active for the run **and** resolution succeeded for that session. It is either fully valid (`repository` + `commitSha`, optional `branch`) or absent — never partial.

**Credential-/path-free guarantee (FR-005, FR-015, SC-003)**: no field ever contains an access token, password, or absolute filesystem path. Identity is derived by extracting host/owner/name into fresh strings and discarding the rest of the `origin` URL; an unparseable URL yields **no** `gitContext` (fail-closed), never a partial/unsafe one.

---

## 4. Relationship to the redacted payload and the ledger (FR-011, SC-007)

`gitContext` is manifest **metadata**, transmitted alongside the redacted session payload, never inside it:

- It is **not** run through the anonymizer.
- It is **not** included in the bytes PUT to the session's presigned URL.
- It is **not** part of `contentHash` (the sha256 of the redacted payload that the `001` incremental ledger keys on, `001` FR-006c).

Consequence: enabling or disabling `--link-prs` on an otherwise-unchanged session does **not** change its `contentHash`, so the `001` classifier still labels it `unchanged` and skips it. Git context attaches only to the `(new ∪ updated)` batch actually uploaded — there is no retroactive backfill (spec Assumptions).

---

## 5. Cloud consumption (informational)

The cloud stores the association as the reserved `pr_id` key in `parsed_artifacts.summary` once its GitHub OAuth + PR-matching engine lands (cloud `005` Assumptions). It matches `gitContext` against pull requests on the user's connected account (`host`/`owner`/`name` scope the search; `branch`/`commitSha` do the matching) and computes org merge rate from sessions linked to merged vs. closed-without-merge PRs (cloud `005` FR-028). A session with **no** `gitContext` simply never links and is excluded from the merge-rate denominator (cloud `005` Edge Cases) — by design, optional and best-effort per session.

The cloud consumer is deferred on the cloud roadmap; until it ships, an attached `gitContext` is stored and unused — harmless (spec Cross-repo context).

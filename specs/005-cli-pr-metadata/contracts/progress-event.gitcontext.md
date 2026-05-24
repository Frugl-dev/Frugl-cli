# Contract: `--json` git-context additions (005-cli-pr-metadata)

**Feature**: 005-cli-pr-metadata | **Date**: 2026-05-24

This documents the **strictly additive** extensions to the `001-cli-ingest-client` machine-readable output contracts (`progress-event.schema.json` and the `UploadFinalSummary` in `command-output.schema.json`) required by FR-016. All additions are optional and present only when `poppi upload --link-prs` was active. `001` consumers are required to tolerate unknown fields (`progress-event.schema.json` forward-compatibility note), so these additions are non-breaking by `001`'s own rules. Per FR-012 / `001` FR-036 these are stable public contract surface.

---

## 1. `upload-start` NDJSON event (additive)

The `001` `upload-start` event gains one OPTIONAL object, `gitContext`, summarising the batch's PR-linking posture. Absent when `--link-prs` is off.

```jsonc
{
  "event": "upload-start",
  "seq": 0,
  "ts": "2026-05-24T18:03:11.220Z",
  "manifestId": "up_…",
  "expectedSessionCount": 5,
  "redactionPolicyVersion": "v0.1",
  "endpoint": "https://api.poppi.app",
  "gitContext": {
    // ← OPTIONAL, ADDITIVE (FR-016)
    "active": true,
    "sessionsWithContext": 4, // count of this batch's sessions that resolved a GitContext
    "repositories": ["acme/widgets", "acme/api"], // distinct owner/name; credential-/path-free (FR-015)
  },
}
```

| Field                            | Type          | Notes                                                                                             |
| -------------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `gitContext.active`              | `boolean`     | Mirrors the effective `--link-prs` opt-in. Present only when the event carries the object at all. |
| `gitContext.sessionsWithContext` | `integer ≥ 0` | How many of `expectedSessionCount` carry a resolved `gitContext`.                                 |
| `gitContext.repositories`        | `string[]`    | Distinct `owner/name` strings. NEVER a credential or absolute path (FR-015).                      |

When `--link-prs` is off, the `gitContext` object is omitted entirely (NOT emitted with `active: false`), keeping the default-off `--json` stream byte-identical to `001` (FR-002, SC-001).

---

## 2. Final manifest-summary (last stdout line) (additive)

The `001` `UploadFinalSummary` (`command-output.schema.json` → `$defs.UploadFinalSummary`, the last stdout line in both text and `--json` modes) gains one OPTIONAL object, `gitContext`.

```jsonc
{
  "command": "upload",
  "ok": true,
  "manifestId": "up_…",
  "actualSessionCount": 5,
  "expectedSessionCount": 5,
  "redactionPolicyVersion": "v0.1",
  "sourceKind": "claude-code",
  "endpoint": "https://api.poppi.app",
  "dashboardUrl": "https://app.poppi.app/u/…",
  "classification": { "discovered": 12, "unchanged": 7, "new": 4, "updated": 1 },
  "limited": { "active": false },
  "gitContext": {
    // ← OPTIONAL, ADDITIVE (FR-016)
    "active": true,
    "sessionsWithContext": 4,
    "repositories": ["acme/widgets", "acme/api"],
  },
}
```

| Field                            | Type          | Notes                                                            |
| -------------------------------- | ------------- | ---------------------------------------------------------------- |
| `gitContext.active`              | `boolean`     | The effective opt-in for the run.                                |
| `gitContext.sessionsWithContext` | `integer ≥ 0` | Sessions in the final manifest carrying a resolved `gitContext`. |
| `gitContext.repositories`        | `string[]`    | Distinct `owner/name`; credential-/path-free (FR-015).           |

As with the event, the object is omitted entirely when `--link-prs` is off, preserving the byte-for-byte default path (FR-002).

**Additive-merge note**: `command-output.schema.json` declares `UploadFinalSummary` with `additionalProperties: false`. The contract bump adds the optional `gitContext` property to that object's declared properties (it does NOT relax `additionalProperties`). This is the same additive mechanism as the manifest `gitContext` (see `manifest-gitcontext.md` §2). When `001`'s `command-output.schema.json` is next revised, fold this property into `$defs.UploadFinalSummary.properties`.

---

## 3. What is NOT changed

- The `session-start`, `session-acked`, `session-failed`, `session-skipped`, and `upload-complete` events are **unchanged**. Per-session git context travels in the manifest itself (see `manifest-gitcontext.md`); the events are not required to carry it, keeping them lean.
- No new event type is introduced.
- No absolute path, `cwd`, or credential appears in any event or summary field (FR-015).
- The `seq` monotonicity invariant (`001`) is unaffected.

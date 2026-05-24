# Phase 1 Data Model: poppi-cli PR-link metadata

**Feature**: 005-cli-pr-metadata | **Date**: 2026-05-24

This feature adds **one** internal entity (`GitContext`) and threads it through existing `001` shapes additively. Public contract shapes (what the CLI emits or sends) live in `contracts/`; this file is the **internal** model. It identifies the new entity, the existing entities it extends, the attach points, and the validation/invariants — mirroring `001/data-model.md`.

The single source-of-truth module for producing this entity is `src/upload/git-context.ts`; the orchestrator (`src/commands/upload.ts`) is the only caller, and only when the `--link-prs` opt-in is active.

---

## Entity catalogue

### 1. `GitContext` (NEW — the feature's only new entity)

The forge-agnostic git coordinate resolved read-only from a session's working directory. Present on a manifest entry **only** when `--link-prs` is active **and** resolution succeeded. Sent as manifest metadata, never as session payload, never through the anonymizer (research.md R-6).

```ts
interface GitRepositoryIdentity {
  host: string; // e.g. "github.com" — no scheme, no userinfo, no port unless non-default
  owner: string; // e.g. "acme"
  name: string; // e.g. "widgets" — trailing ".git" stripped
}

interface GitContext {
  repository: GitRepositoryIdentity; // required when GitContext is present (FR-005/010)
  branch?: string; // FR-006; OMITTED on detached HEAD; prefers session-recorded gitBranch
  commitSha: string; // FR-007; full 40-hex HEAD SHA for the working dir at upload time
}
```

| Field              | Type      | Source                                  | Notes                                                                                                     |
| ------------------ | --------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `repository.host`  | `string`  | `origin` URL, credential-stripped (R-4) | host only; never carries userinfo. FR-005.                                                                |
| `repository.owner` | `string`  | `origin` URL path segment (R-4)         | non-empty; fail-closed omit of the whole `GitContext` if not parseable (FR-005).                          |
| `repository.name`  | `string`  | `origin` URL path segment (R-4)         | non-empty; trailing `.git` stripped.                                                                      |
| `branch`           | `string?` | recorded `gitBranch`, else `.git/HEAD`  | omitted on detached HEAD (FR-006). Sent verbatim when present (may embed ticket id/codename, by consent). |
| `commitSha`        | `string`  | `.git/HEAD` → loose/packed ref (R-5)    | full 40-hex (FR-007). Required whenever a `GitContext` exists.                                            |

**Validation** (enforced in `git-context.ts`, and re-validated as the public contract via the schema in `contracts/`):

- `host` matches a hostname (lowercase letters, digits, `.`, `-`, optional `:port`); never contains `@`, `/`, or whitespace.
- `owner` and `name` are non-empty, contain no `/`, no whitespace, no `@`.
- `commitSha` matches `^[0-9a-f]{40}$`.
- `branch`, when present, is a non-empty string.
- **Fail-closed invariant (FR-005, SC-003)**: if any of `host`/`owner`/`name` cannot be cleanly produced from the `origin` URL, the resolver returns `undefined` (no `GitContext`) — never a partial or unsanitised identity.

**Privacy invariant (FR-015, SC-003)**: no credential/token substring and no absolute filesystem path is ever assigned to any field of `GitContext`. The resolver builds `host`/`owner`/`name` as freshly extracted strings and discards the remainder of the source URL (research.md R-4), so a token cannot survive into this entity.

**Presence invariant (FR-008)**: a `GitContext` is either fully valid (all required fields) or absent. There is no "half-resolved" `GitContext`.

---

### 2. `GitContextResolution` (NEW — internal resolver result, per session)

The internal return shape of the resolver, so the orchestrator can distinguish "resolved", "not applicable", and "could not inspect git at all" (for the FR-009 global notice) without exceptions.

```ts
type GitContextResolution =
  | { kind: "resolved"; gitContext: GitContext }
  | {
      kind: "unresolved";
      reason:
        | "no-cwd"
        | "missing-dir"
        | "not-a-repo"
        | "no-remote"
        | "unparseable-remote"
        | "no-commit";
    }
  | { kind: "git-unavailable" }; // wholesale inability to read .git anywhere (FR-009 signal)
```

| Variant           | Meaning                                                                               | Effect                                      |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| `resolved`        | A valid `GitContext` was produced.                                                    | Attached to the session's manifest entry.   |
| `unresolved`      | Best-effort miss (FR-008): no cwd, dir gone, not a repo, no remote, unparseable, etc. | Session carries no context; batch proceeds. |
| `git-unavailable` | The host cannot inspect git at all (FR-009 / US4 scenario 5).                         | Drives the single global "skipped" notice.  |

**Rationale for the `reason` enum**: it is internal-only (never transmitted; FR-015), used for tests asserting the graceful-degradation matrix (SC-005) and to keep the orchestrator's notice logic explicit rather than guessing from a bare `undefined`.

**Best-effort invariant (FR-008)**: the resolver **never throws**; every failure path returns an `unresolved` or `git-unavailable` variant.

---

### 3. `EffectiveLinkPrs` (NEW — resolved opt-in, FR-001/003)

The resolved boolean opt-in for one `poppi upload` invocation.

```ts
interface EffectiveLinkPrs {
  active: boolean;
  source: "flag" | "config" | "default"; // for the summary's "PR linking: on/off (from …)" line
}
```

**Computation rule (research.md R-7)**: explicit `--link-prs` flag wins (`source: "flag"`); else the persisted `linkPrs` config value if `true` (`source: "config"`); else `false` (`source: "default"`).

**Hard gate invariant (FR-002, SC-001)**: when `active === false`, the orchestrator MUST NOT call the resolver, MUST NOT read any `cwd` or `.git`, and MUST NOT attach or emit any git field. The resolver is never entered on the default path.

---

### 4. `ParsedSession` (EXTENDED — additive, `001` data-model §4)

The `001` internal `ParsedSession` gains two optional fields so the resolver can find the working directory and the work-time branch without re-reading the source file.

```ts
interface ParsedSession<TRecord = unknown> {
  sourceKind: string;
  ref: SessionRef;
  identity: SessionIdentity;
  records: TRecord[];
  cwd?: string; // NEW — absolute working dir recorded by the source (claude-code: JSONL `cwd`). FR-004.
  recordedBranch?: string; // NEW — work-time branch recorded by the source (claude-code: JSONL `gitBranch`). FR-006.
}
```

| Field            | Type      | Source (claude-code)                | Notes                                                                 |
| ---------------- | --------- | ----------------------------------- | --------------------------------------------------------------------- |
| `cwd`            | `string?` | first JSONL record with `cwd`       | absolute path; consumed transiently by the resolver, never sent.      |
| `recordedBranch` | `string?` | first JSONL record with `gitBranch` | preferred branch per FR-006; may be empty/absent → fall back to HEAD. |

**Additive invariant**: these are optional; existing `ParsedSession` consumers (the anonymizer, classifier) are unaffected. The anonymizer does **not** read `cwd`/`recordedBranch` (they are not in `records`), so they never enter the redacted payload or `redactedHashHex` (FR-011).

---

### 5. `ManifestEntry` (EXTENDED — additive, the public contract; `001` data-model §9)

The CLI-side `ManifestEntry` gains an optional `gitContext`. This is the strictly-additive extension to the `001` public manifest contract (`contracts/manifest.schema.json`, mirrored in `contracts/manifest-entry.gitcontext.schema.json`).

```ts
interface ManifestEntry {
  sessionId: string;
  identityDerivation: "native" | "path-hash";
  contentHash: string; // sha256 of the REDACTED PAYLOAD — gitContext is NOT part of this (FR-011, SC-007)
  byteSize: number;
  // ... existing 001 resume/accounting fields unchanged ...
  gitContext?: GitContext; // NEW — present only when --link-prs active AND resolution succeeded (FR-010)
}
```

**Attach point**: the orchestrator attaches the resolved `GitContext` (when `kind === "resolved"`) to the corresponding `SessionUploadJob` and thence into the manifest-create request body's per-session object (`src/upload/pipeline.ts`), as an additive `git_context` field on the wire (snake_case, matching `001`'s `session_id`/`format_version` convention; `src/cloud/schemas.ts` `manifestEntryRequestSchema` gains an optional `git_context`).

**No-churn invariant (FR-011, SC-007)**: `contentHash` is `AnonymizationResult.redactedHashHex`, computed before and independent of `gitContext`. Adding/removing `gitContext` does not change `contentHash`, so the `001` classifier (data-model §8) still labels an otherwise-unchanged session `unchanged`.

**Backward-compat invariant (FR-010, SC-006)**: `gitContext` is optional and additive; no `001` field is renamed, removed, or made required. A consumer that ignores `gitContext` reads the manifest identically to a no-flag manifest.

---

### 6. `UploadSummary` (EXTENDED — additive, `001` upload/summary)

The pre-upload summary gains the PR-linking audit fields (FR-013).

```ts
interface UploadSummary {
  // ... existing 001 fields unchanged ...
  prLinking?: {
    active: boolean; // mirrors EffectiveLinkPrs.active
    source: "flag" | "config" | "default";
    sessionsWithContext: number; // count of willUpload sessions that resolved a GitContext
    repositories: string[]; // distinct "owner/name" (or "host/owner/name"), credential-/path-free (FR-015)
  };
}
```

**Render rule**: when `prLinking.active` is true, `formatSummaryForHuman` prints `PR linking: on`, the `N of M` count, and the distinct repo list. When false, prints `PR linking: off` (FR-002 scenario 2). The `repositories` array NEVER contains a credential or absolute path (FR-015).

---

### 7. Persisted config: `PoppiConfig` (NEW — optional, FR-003)

```ts
interface PoppiConfig {
  schemaVersion: 1;
  linkPrs: boolean; // default false
}
```

Stored via `conf` under a new `poppi-config` namespace in the env-paths state dir (`src/lib/paths.ts`). **Validation**: `zod` schema; schema-version mismatch or missing file → treated as defaults (`linkPrs: false`), never a failure. **Privacy invariant**: holds only the boolean preference — no repository data ever.

---

## Where this data attaches in the `001` pipeline

```
ParsedSession (now carries cwd?, recordedBranch?)   [src/sources/claude-code/parse.ts]
        │
        │  (only when EffectiveLinkPrs.active — FR-002 hard gate)
        ▼
resolveGitContext(cwd, recordedBranch)  ──► GitContextResolution   [src/upload/git-context.ts]
        │
        ├─ kind:"resolved"        → GitContext attached to SessionUploadJob
        ├─ kind:"unresolved"      → no context (best-effort, FR-008)
        └─ kind:"git-unavailable" → drives FR-009 global notice
        │
        ▼
SessionUploadJob.gitContext?  ──► manifest-create body `sessions[].git_context`   [src/upload/pipeline.ts]
        │                                  (metadata; NOT in payload, NOT in redactedHashHex — FR-011)
        ▼
ManifestEntry.gitContext?  (public contract, additive — FR-010, SC-006)
        │
        ├─► UploadSummary.prLinking  ──► pre-upload confirmation (FR-013)   [src/upload/summary.ts]
        ├─► inspection output (distinct from redacted payload — FR-014)     [src/commands/upload.ts]
        └─► --json upload-start + final summary (additive — FR-016)         [src/upload/progress.ts]
```

---

## Where validation lives

| Surface                                           | Tool                                 | File                                   |
| ------------------------------------------------- | ------------------------------------ | -------------------------------------- |
| `GitContext` shape + fail-closed credential-strip | plain TS + unit assertions           | `src/upload/git-context.ts`            |
| Manifest-create `git_context` wire field          | `zod` (additive optional)            | `src/cloud/schemas.ts`                 |
| Public manifest contract (`gitContext` optional)  | JSON-schema + backward-compat test   | `specs/005-cli-pr-metadata/contracts/` |
| Persisted `linkPrs` config on read                | `zod`; mismatch → defaults           | `src/lib/config.ts`                    |
| `--link-prs` flag parsing + opt-in precedence     | oclif flag + `EffectiveLinkPrs` rule | `src/commands/upload.ts`               |

The fail-closed credential-strip and the no-ledger-churn invariant are the two release-blocking behaviours; both are pinned by tests (SC-003, SC-007).

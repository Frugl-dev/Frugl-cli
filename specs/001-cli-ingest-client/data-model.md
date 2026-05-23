# Phase 1 Data Model: poppi-cli v1

**Feature**: 001-cli-ingest-client | **Date**: 2026-05-23

Entities the CLI manipulates internally. Public contract shapes (what the CLI emits to stdout/stderr or sends to the cloud) live in `contracts/`; this file is the **internal** model. Entities here drive module boundaries (`src/sources/`, `src/ledger/`, `src/upload/`, etc.) and identify the validation rules (mostly enforced via `zod` schemas in `src/cloud/schemas.ts` for the cloud-facing slice, plain TypeScript discriminated unions for the rest).

---

## Entity catalogue

### 1. `AuthSession`

Identifies the currently signed-in user. The persisted form lives only in the OS keychain (FR-004); the in-memory form is loaded by `src/auth/keychain.ts` once per command invocation.

| Field         | Type                | Source                  | Notes                                                                                                         |
| ------------- | ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `email`       | `string`            | OTP login               | the user's authenticated email; also referenced by anonymizer as `ownerEmail` (FR-012)                        |
| `userId`      | `string`            | cloud response on login | server-assigned, opaque, used as the ledger key partition (FR-006c)                                           |
| `token`       | `string`            | cloud response on login | bearer token, sent on every cloud call; stored in keychain only                                               |
| `endpointUrl` | `string`            | resolved at login time  | endpoint this session is for (so a re-run against a different `--endpoint` is treated as a different session) |
| `loggedInAt`  | `string` (ISO 8601) | client clock at login   | for `whoami` output                                                                                           |

**Validation**: `email` matches RFC 5321 simplified; `token` non-empty; `endpointUrl` is a valid `URL`. Validation failures on read = "not logged in" (FR-003), not a runtime error.

**State transitions**: `(none) --login()--> AuthSession --logout()--> (none)`. An invalidated token (cloud returns 401/403 on a subsequent call) is **not** auto-refreshed; the CLI emits the auth-failure exit code and instructs re-login (spec edge case).

---

### 2. `Endpoint`

Where to talk to. Resolved per command invocation (R-13).

| Field          | Type                           | Notes                                     |
| -------------- | ------------------------------ | ----------------------------------------- |
| `url`          | `string`                       | canonical, no trailing slash              |
| `resolvedFrom` | `'flag' \| 'env' \| 'default'` | for the resolved-endpoint diagnostic line |

**Validation**: `url` parses as `URL` with `https:` or (for `localhost`) `http:` scheme. `http:` for non-localhost hosts = hard error (PR-style review burden, but tooled here so a user can't accidentally upload to a plain-HTTP endpoint).

---

### 3. `Source` and `SessionRef`

The FR-007 open extension point. v1 ships one `Source` implementation: `claudeCode`.

```ts
interface Source {
  kind: string; // e.g. "claude-code"; recorded in manifest (FR-008)
  discover(opts: { endpoint: Endpoint }): Promise<SessionRef[]>;
  parse(ref: SessionRef): Promise<ParsedSession>;
  deriveIdentity(ref: SessionRef, parsed: ParsedSession): SessionIdentity;
}
```

#### `SessionRef`

A discovered file on disk before any parsing or hashing.

| Field            | Type     | Notes                                                    |
| ---------------- | -------- | -------------------------------------------------------- |
| `sourceKind`     | `string` | mirrors `Source.kind`                                    |
| `absolutePath`   | `string` | canonical absolute (after `path.resolve`)                |
| `byteSizeOnDisk` | `number` | from `fs.stat`; used for the pre-upload summary estimate |
| `mtimeMs`        | `number` | for `--limit N` ordering (R-1)                           |

#### `SessionIdentity`

The stable per-session identifier (FR-006b).

| Field        | Type                      | Notes                                                                |
| ------------ | ------------------------- | -------------------------------------------------------------------- |
| `sessionId`  | `string`                  | source-native (Claude Code: from JSONL) OR derived (path-hash, R-10) |
| `derivation` | `'native' \| 'path-hash'` | recorded in manifest so cloud can distinguish                        |

**Validation**: `sessionId` non-empty, ≤ 128 chars, matches `[A-Za-z0-9._-]+`.

**Invariant**: For a given on-disk file on a given machine, `sessionId` MUST be deterministic across runs and across CLI versions (FR-006b). Tests pin this for the Claude Code source by asserting that two `deriveIdentity()` calls on the same fixture return identical results.

---

### 4. `ParsedSession`

The in-memory shape after `Source.parse()`, before anonymization. Source-specific.

For `claude-code`:

```ts
interface ClaudeCodeParsedSession {
  sourceKind: "claude-code";
  ref: SessionRef;
  identity: SessionIdentity;
  records: ClaudeCodeRecord[]; // one per JSONL line
}
```

This shape is **internal**; the anonymizer is the only consumer. No public contract.

---

### 5. `AnonymizationResult`

The output of `anonymize(session, opts)`. Recorded once per session.

| Field                  | Type                                | Notes                                                                   |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `payload`              | `unknown`                           | the redacted JSON payload that will be PUT to the presigned URL         |
| `redactionsByCategory` | `Record<RedactionCategory, number>` | counts per FR-010..013 category                                         |
| `policyVersion`        | `string`                            | `POLICY_VERSION` constant (R-12)                                        |
| `redactedHashHex`      | `string`                            | sha256 of the serialized `payload`; used as ledger `contentHash` (R-15) |
| `byteSize`             | `number`                            | serialized (post-gzip) size; used for the summary and progress events   |

```ts
type RedactionCategory =
  | "anthropic-key"
  | "openai-key"
  | "aws-key"
  | "gcp-key"
  | "github-token"
  | "slack-webhook"
  | "env-line"
  | "home-path"
  | "project-name"
  | "third-party-email"
  | "entropy-fallback";
```

**Invariant (SC-001)**: For the canonical planted-secrets fixture, every planted value is absent from `JSON.stringify(payload)`. Enforced by vitest in CI; release-blocking on regression.

**Invariant (FR-016)**: Pseudonyms substituted into `payload` are stable within a single call's `PseudonymTable` (so cross-session joins within the batch work) and NOT stable across different invocations.

---

### 6. `PseudonymTable`

Per-upload, per-category, in-memory (R-16).

| Field      | Type                                             | Notes                          |
| ---------- | ------------------------------------------------ | ------------------------------ |
| `uploadId` | `string`                                         | the HMAC seed                  |
| `tables`   | `Record<RedactionCategory, Map<string, string>>` | one mapping table per category |

API:

```ts
class PseudonymTable {
  constructor(uploadId: string);
  pseudonymize(category: RedactionCategory, realValue: string): string;
}
```

**Invariant**: `pseudonymize('project-name', 'acme')` returns the same string twice in a row within the same `PseudonymTable` instance; two different `PseudonymTable` instances (different `uploadId`s) return different strings for the same input.

---

### 7. `LedgerEntry` and `Ledger`

The local upload ledger (FR-006c).

```ts
interface LedgerEntry {
  sessionId: string;
  contentHash: string; // sha256 of the redacted payload bytes (R-15)
  lastUploadedAt: string; // ISO 8601
  manifestId: string; // the manifest under which this version was uploaded
}

interface Ledger {
  schemaVersion: 1;
  entries: Record<string /* sessionId */, LedgerEntry>;
}
```

Stored via `conf` under namespace `poppi-ledger`, keyed at the file level by `(endpoint URL, userId)` (the conf instance is keyed; entries within are flat by sessionId).

**Validation**: zod schema in `src/ledger/ledger.ts`. Schema-version mismatch on read = treated as ledger loss per FR-006f (not a failure).

**Atomicity**: every write goes through `conf`'s atomic write-temp-then-rename (FR-006c requirement).

**Privacy invariant (FR-006g)**: the ledger is never transmitted off the machine; no code path serializes it into any cloud request body.

---

### 8. `SessionClassification`

Per-discovered-session label, computed by `ledger/classify.ts` (FR-006d).

```ts
type SessionClassification =
  | { kind: "unchanged"; ref: SessionRef; identity: SessionIdentity; ledgerEntry: LedgerEntry }
  | { kind: "new"; ref: SessionRef; identity: SessionIdentity }
  | { kind: "updated"; ref: SessionRef; identity: SessionIdentity; previousEntry: LedgerEntry };
```

**Computation rule**:

1. Look up `entries[identity.sessionId]`. If absent → `new`.
2. If present, compute the **current** redacted-payload hash by anonymizing the parsed session (yes, we run anonymization once during classification — this is the cost SC-003a budgets ≤ 5 s for M=1000).
3. If `currentHash === previousEntry.contentHash` → `unchanged`. Else → `updated`.

**Ordering invariant**: classification → `--limit N` truncation → (new ∪ updated) only is anonymized for upload. Note: classification itself does run anonymization to compute the hash, but the resulting payload for `unchanged` sessions is discarded immediately. (Alternative: cache the result for `new`/`updated` to avoid a second anonymization run — implementation detail, not a model constraint.)

---

### 9. `Manifest` (CLI-side view)

The CLI's local view of an in-flight manifest. The cloud-side view is the canonical record; this is the CLI's accounting.

```ts
interface Manifest {
  manifestId: string; // cloud-assigned on create
  cliVersion: string; // from package.json
  redactionPolicyVersion: string; // POLICY_VERSION (R-12, FR-017)
  sourceKind: string;
  expectedSessionCount: number; // immutable after manifest create
  endpointUrl: string;
  userId: string; // for ledger partitioning
  entries: ManifestEntry[];
}

interface ManifestEntry {
  sessionId: string;
  identityDerivation: "native" | "path-hash";
  contentHash: string; // sha256 of the redacted payload
  byteSize: number; // post-gzip
  sourceFilePath: string; // absolute; used by resume for hash verification (FR-027b)
  rawContentHashAtFirstRun: string; // sha256 of raw source bytes at first-run (R-15)
  status: "pending" | "in-flight" | "acked" | "skipped-on-resume";
  ackedAt?: string; // ISO 8601, set on cloud ack
  skippedReason?: "missing" | "modified";
}
```

**State transitions** for `ManifestEntry.status`:

```
pending --pipeline-picks-up--> in-flight --presigned-PUT-ok--> acked
                                       \--PUT-fails-3x--> (pending; pipeline re-enqueues on next run)
pending --resume-check-detects-missing/modified--> skipped-on-resume
```

`acked` is terminal-positive. `skipped-on-resume` is terminal-neutral (counted in the final manifest's actual session count, NOT in `expectedSessionCount` — FR-027b: "the completion call MUST report the actual final session count").

**Invariant**: `entries[].sessionId` are unique within a manifest (a manifest cannot contain two entries for the same session).

---

### 10. `ResumeState`

Persisted form of an in-flight `Manifest`. One record at a time (the CLI does not support overlapping uploads in v1).

```ts
interface ResumeState {
  schemaVersion: 1;
  manifest: Manifest; // status field on each entry is the resume cursor
  beganAt: string; // ISO 8601
}
```

Stored via `conf` under namespace `poppi-resume-state`. **Cleared** when the cloud's completion endpoint returns OK for this manifest (FR-028).

**Validation**: zod schema. Schema-version mismatch on read = treated as no resume state (start fresh; the user will see normal "begin a fresh upload" UX).

**Recovery (FR-027a)**: when the cloud responds "no such upload" for `manifest.manifestId`, the CLI clears this state, surfaces the FR-027a notice, and starts a new manifest. Treated as normal operation.

---

### 11. `ProgressEvent`

NDJSON events emitted on stdout under `--json` (FR-039). Public contract — see `contracts/progress-event.schema.json`. Internal shape mirrors:

```ts
type ProgressEvent =
  | {
      event: "upload-start";
      seq: number;
      ts: string;
      manifestId: string;
      expectedSessionCount: number;
      redactionPolicyVersion: string;
    }
  | {
      event: "session-start";
      seq: number;
      ts: string;
      manifestId: string;
      sessionId: string;
      byteSize: number;
    }
  | { event: "session-acked"; seq: number; ts: string; manifestId: string; sessionId: string }
  | {
      event: "session-failed";
      seq: number;
      ts: string;
      manifestId: string;
      sessionId: string;
      reason: string;
    }
  | {
      event: "session-skipped";
      seq: number;
      ts: string;
      manifestId: string;
      sessionId: string;
      reason: "missing" | "modified";
    }
  | {
      event: "upload-complete";
      seq: number;
      ts: string;
      manifestId: string;
      actualSessionCount: number;
      dashboardUrl: string;
    };
```

**Invariant**: `seq` is monotonically increasing within one `poppi upload` invocation, starting at 0. Recipients can use it to detect gaps in piped processing.

---

### 12. `CommandResult` (login/logout/whoami)

Structured form of the final stdout line emitted by `login`, `logout`, `whoami` under `--json` (FR-040). Public contract — see `contracts/command-output.schema.json`.

```ts
type CommandResult =
  | { command: "login"; ok: true; email: string; endpoint: string }
  | { command: "logout"; ok: true }
  | {
      command: "whoami";
      ok: true;
      email: string;
      userId: string;
      endpoint: string;
      loggedInAt: string;
    }
  | { command: "whoami"; ok: false; reason: "not-logged-in" };
```

**Invariant**: `ok: false` shapes still exit with the appropriate documented exit code (FR-037); the JSON body is for tool consumption, the exit code is for shell consumption.

---

### 13. `ExitCode`

Frozen table (FR-037). Public contract — see `contracts/exit-codes.md`. Internal source-of-truth lives in `src/lib/exit-codes.ts`:

```ts
export const EXIT = {
  OK: 0,
  GENERIC_FAILURE: 1,
  USAGE: 2,
  AUTH_FAILURE: 10,
  KEYCHAIN_UNAVAILABLE: 11,
  NO_SESSIONS_FOUND: 20,
  ANONYMIZATION_FAILURE: 30,
  NETWORK_FAILURE: 40,
  VERSION_GATE_FAILURE: 50,
  ENDPOINT_UNREACHABLE: 41,
  INSPECT_DIR_EXISTS: 60,
} as const;
```

**Invariant**: every documented failure mode (spec Edge Cases + FR list) maps to exactly one code; no two failures share a code; SC-006 enforced by tests that drive each failure path and assert the code.

---

## Relationships

```
AuthSession ──pairs with──> Endpoint
       │
       └──userId+endpoint key──┐
                               ▼
SessionRef ──parse()──> ParsedSession ──anonymize()──> AnonymizationResult
       │                                                          │
       │                                                          ▼
       │                            Ledger.entries[sessionId] = LedgerEntry
       │
       └──deriveIdentity()──> SessionIdentity
                                       │
                                       ▼
       SessionClassification ──{new,updated subset, --limit applied}──> ManifestEntry[]
                                                                              │
                                                                              ▼
                                                                          Manifest ──persist──> ResumeState
                                                                              │
                                                                              ▼
                                                                         ProgressEvent
                                                                              │
                                                                              ▼
                                                                       (stdout NDJSON / stderr text)
```

---

## Where validation lives

| Surface                                                                         | Tool                                                             | File                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------ |
| Cloud HTTP responses                                                            | `zod` runtime validation                                         | `src/cloud/schemas.ts`   |
| Ledger on read                                                                  | `zod`                                                            | `src/ledger/ledger.ts`   |
| Resume state on read                                                            | `zod`                                                            | `src/upload/resume.ts`   |
| Public CLI flag combinations (e.g. `--inspect` without `--dry-run` is an error) | oclif's flag system + a custom assertion in `commands/upload.ts` | `src/commands/upload.ts` |
| Path-traversal on `--inspect <dir>`                                             | explicit `path.resolve` + cwd-prefix check                       | `src/commands/upload.ts` |

All schema mismatches surface as honest failures with a stable exit code; never silently coerced.

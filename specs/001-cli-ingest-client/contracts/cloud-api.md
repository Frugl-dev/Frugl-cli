# Cloud HTTP Boundary (consumed by frugl-cli v1)

**Feature**: 001-cli-ingest-client | **Date**: 2026-05-23 | **Status**: contract surface

The CLI consumes the cloud's HTTP endpoints; it does not embed `@supabase/supabase-js` (research.md R-8). This document records what the CLI expects from the cloud — verbatim consumer expectations against the cloud's `001-cloud-ingest-platform` spec. **Any change here MUST be coordinated with the cloud repo per the spec.md "Cross-repo expectations on the cloud" section.**

For each endpoint: method + path, expected status codes, request shape, response shape (validated via `zod` in `src/cloud/schemas.ts`), and the CLI's behavior on each documented failure status.

---

## Common request headers (every authenticated call)

| Header           | Value                                      | FR         |
| ---------------- | ------------------------------------------ | ---------- |
| `Authorization`  | `Bearer <token>` from keychain             | FR-001/004 |
| `X-Frugl-Client` | `frugl-cli/<semver>` (from `package.json`) | FR-032     |
| `Content-Type`   | `application/json` for JSON bodies         | —          |

## Common response status semantics (every endpoint)

| Status                            | CLI behavior                                                                              | Exit code                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `2xx`                             | Honor per-endpoint                                                                        | OK or continue                                                                                                        |
| `401` / `403`                     | NEVER retried (FR-029b); surface "re-run `frugl login`"                                   | `AUTH_FAILURE` (10)                                                                                                   |
| `426 Upgrade Required`            | NEVER retried (FR-029b); parse body for `minSupportedCliVersion`, surface upgrade message | `VERSION_GATE_FAILURE` (50)                                                                                           |
| `429`                             | Retried per FR-029a (bounded exponential backoff, 3 attempts total)                       | `NETWORK_FAILURE` (40) if exhausted                                                                                   |
| `5xx`                             | Retried per FR-029a                                                                       | `NETWORK_FAILURE` (40) if exhausted                                                                                   |
| Other `4xx`                       | NEVER retried (FR-029b); surface response body                                            | `NETWORK_FAILURE` (40)                                                                                                |
| Network error (DNS, RST, timeout) | Retried per FR-029a                                                                       | `NETWORK_FAILURE` (40) or `ENDPOINT_UNREACHABLE` (41) if explicit `--endpoint` was unreachable from the first attempt |

---

## Endpoints

### Authentication

#### `POST /auth/otp/request`

Request a one-time code be emailed to the user.

**Request body**:

```json
{ "email": "user@example.com" }
```

**Success response** (`200 OK`):

```json
{ "ok": true }
```

**Documented failures**:

| Status | Meaning               | CLI exit code                                 |
| ------ | --------------------- | --------------------------------------------- |
| `400`  | Malformed email       | `USAGE` (2)                                   |
| `429`  | Too many OTP requests | `NETWORK_FAILURE` (40) after retry exhaustion |

---

#### `POST /auth/otp/verify`

Exchange the email + code for a session token.

**Request body**:

```json
{ "email": "user@example.com", "code": "123456" }
```

**Success response** (`200 OK`):

```json
{
  "ok": true,
  "userId": "usr_xxx",
  "email": "user@example.com",
  "token": "...",
  "tokenIssuedAt": "2026-05-23T12:00:00.000Z"
}
```

CLI behavior: persist `{userId, email, token}` to OS keychain under service `frugl`, account `<endpointUrl>`.

**Documented failures**:

| Status | Meaning                   | CLI exit code       |
| ------ | ------------------------- | ------------------- |
| `400`  | Code expired or malformed | `AUTH_FAILURE` (10) |
| `401`  | Code wrong                | `AUTH_FAILURE` (10) |

---

#### `POST /auth/logout`

Invalidate the session at the cloud (FR-002).

**Request body**: (empty)

**Success response** (`200 OK`):

```json
{ "ok": true }
```

CLI behavior: even on `200`, also delete the local keychain entry. On `401`/`403`, still delete the local keychain entry (the token is dead either way) and exit OK — logout is idempotent from the user's perspective.

---

#### `GET /auth/whoami`

Report the currently authenticated identity (FR-003).

**Success response** (`200 OK`):

```json
{
  "userId": "usr_xxx",
  "email": "user@example.com",
  "loggedInAt": "2026-05-23T12:00:00.000Z"
}
```

**Documented failures**:

| Status | Meaning                     | CLI exit code                                                           |
| ------ | --------------------------- | ----------------------------------------------------------------------- |
| `401`  | No session or token invalid | `AUTH_FAILURE` (10), with the `whoami`-specific "not logged in" message |

---

### Upload pipeline

#### `POST /uploads`

Create a manifest. The CLI sends the per-session entries it intends to upload (`expectedSessionCount` and an entry array of `{sessionId, identityDerivation, contentHash, byteSize}`). The cloud responds with the `manifestId`.

**Request body**:

```json
{
  "cliVersion": "0.1.0",
  "redactionPolicyVersion": "v0.1",
  "sourceKind": "claude-code",
  "expectedSessionCount": 5,
  "sessions": [
    {
      "sessionId": "sess_abc",
      "identityDerivation": "native",
      "contentHash": "sha256-hex...",
      "byteSize": 14523
    }
  ]
}
```

**Success response** (`201 Created`):

```json
{ "manifestId": "mfst_xxx" }
```

**Documented failures**:

| Status | Meaning                                                                   | CLI exit code                                                      |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `400`  | Schema mismatch (e.g. unknown `sourceKind`, malformed `sessionId`)        | `GENERIC_FAILURE` (1), surface zod error message                   |
| `409`  | Conflict on manifest creation after a retried response was lost (FR-029d) | `GENERIC_FAILURE` (1) — never silently create a duplicate manifest |
| `426`  | CLI below minimum supported version                                       | `VERSION_GATE_FAILURE` (50)                                        |

---

#### `POST /uploads/{manifestId}/sessions/{sessionId}/presign`

Mint a presigned URL for a single session. Idempotent within a manifest — re-calling for the same `(manifestId, sessionId)` returns a fresh URL targeting the same object key (so FR-029d "retried presign is permitted" is honored).

**Request body**:

```json
{ "byteSize": 14523 }
```

**Success response** (`200 OK`):

```json
{
  "url": "https://s3.amazonaws.com/...?X-Amz-Signature=...",
  "method": "PUT",
  "headers": {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "gzip"
  },
  "expiresAt": "2026-05-23T12:15:00.000Z"
}
```

CLI behavior: PUT the gzipped, anonymized payload to `url` with `method` and `headers`. Treat the URL as **single-attempt within the URL's TTL**; on a transient failure, the CLI re-presigns and tries again rather than reusing a potentially-expired URL.

**Documented failures**:

| Status | Meaning                               | CLI exit code                                                |
| ------ | ------------------------------------- | ------------------------------------------------------------ |
| `404`  | Manifest unknown (stale resume state) | Trigger FR-027a recovery: clear resume, start fresh manifest |
| `410`  | Manifest already completed            | Trigger FR-027a recovery (manifest is closed)                |
| `426`  | Version gate                          | `VERSION_GATE_FAILURE` (50)                                  |

---

#### `PUT <presigned-url>`

Direct upload to the cloud-managed object store (FR-023). No `Authorization` header (the URL carries the credential).

**Request body**: gzipped JSON payload of the anonymized session.

**Success**: 2xx (commonly `200`).

**Documented failures**:

| Status | Meaning                          | CLI behavior                                                                                                      |
| ------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `403`  | URL expired or signature invalid | Re-presign once (FR-029d allows it; presign is idempotent), then retry. If still failing → `NETWORK_FAILURE` (40) |
| `5xx`  | Object store transient           | Bounded retry per FR-029a                                                                                         |

---

#### `POST /uploads/{manifestId}/complete`

Finalize the manifest (FR-024/028). Idempotent: calling twice with the same body returns the same response.

**Request body**:

```json
{
  "actualSessionCount": 5,
  "ackedSessionIds": ["sess_abc", "sess_def", ...]
}
```

`actualSessionCount` is the count of `acked` ManifestEntries (may be less than `expectedSessionCount` if some entries were `skipped-on-resume` per FR-027b).

**Success response** (`200 OK`):

```json
{ "manifestId": "mfst_xxx", "dashboardUrl": "https://app.frugl.app/uploads/mfst_xxx" }
```

CLI behavior on success: clear local resume state (FR-028), update ledger entries for every `acked` session (FR-006e), print the manifest ID and dashboard URL on stdout (FR-025).

**Documented failures**:

| Status | Meaning                                          | CLI exit code                                            |
| ------ | ------------------------------------------------ | -------------------------------------------------------- |
| `400`  | Acknowledged session set doesn't match expected  | `GENERIC_FAILURE` (1)                                    |
| `404`  | Manifest unknown                                 | Trigger FR-027a recovery                                 |
| `409`  | Manifest already completed with different counts | `GENERIC_FAILURE` (1); surface for manual reconciliation |
| `426`  | Version gate                                     | `VERSION_GATE_FAILURE` (50)                              |

---

## Notes

- All request and response shapes above are mirrored as `zod` schemas in `src/cloud/schemas.ts`. The CLI runs `Schema.parse()` on every response body; a `ZodError` becomes a `GENERIC_FAILURE` (1) with a diagnostic naming the offending field. This is the cross-repo drift sentinel per Principle VI ("Honest failures") and FR-036.
- The CLI never queries the cloud for "which sessions do you already have?" — FR-006g. The ledger is local-only authority.
- No bulk-fetch / list endpoints are consumed by the CLI in v1.

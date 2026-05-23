# Exit Codes (v1)

**Feature**: 001-cli-ingest-client | **FR**: FR-037 | **Status**: contract surface (FR-036)

Every documented failure mode maps to exactly one stable exit code. Scripts and the future MCP wrapper branch on these codes; the codes never shift between releases without a coordinated cross-repo bump.

The single source of truth in code is `src/lib/exit-codes.ts`. This document is the human-facing contract.

| Code | Symbol                  | When                                                                                                                                   | Triggering FR / edge case                                                                                                                                |
| ---: | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  `0` | `OK`                    | Command succeeded.                                                                                                                     | All happy paths.                                                                                                                                         |
|  `1` | `GENERIC_FAILURE`       | Unexpected error not covered by a more specific code. Includes zod-validation failures of cloud responses (cross-repo drift).          | Last-resort catch.                                                                                                                                       |
|  `2` | `USAGE`                 | Invalid flag combination or malformed input parsed locally.                                                                            | e.g. `--inspect` without `--dry-run`; malformed `--limit`; malformed email format on local check.                                                        |
| `10` | `AUTH_FAILURE`          | Cloud rejected the auth token (401/403), or `whoami` ran with no stored session.                                                       | FR-001/002/003; spec edge case "Expired or revoked auth token".                                                                                          |
| `11` | `KEYCHAIN_UNAVAILABLE`  | OS credential store could not be reached (libsecret missing on headless Linux; locked keychain).                                       | FR-005; spec edge case "Keychain unavailable".                                                                                                           |
| `20` | `NO_SESSIONS_FOUND`     | Discovery completed with zero matching session files.                                                                                  | Spec edge case "No sessions found". Note: this is **distinct** from "no NEW or updated sessions to upload" (FR-029), which is an OK exit, not a failure. |
| `30` | `ANONYMIZATION_FAILURE` | One or more sessions failed anonymization; batch aborted before any network transmission.                                              | FR-015.                                                                                                                                                  |
| `40` | `NETWORK_FAILURE`       | A cloud HTTP call failed after exhausting bounded retry (FR-029a), OR a non-retryable 4xx other than auth/version-gate.                | FR-029c.                                                                                                                                                 |
| `41` | `ENDPOINT_UNREACHABLE`  | Explicit `--endpoint` (or `POPPI_ENDPOINT`) host was unreachable from the very first attempt — distinct from a flaky default endpoint. | Spec edge case "User passes `--endpoint` pointing at an unreachable host".                                                                               |
| `50` | `VERSION_GATE_FAILURE`  | Cloud responded `426 Upgrade Required`.                                                                                                | FR-033.                                                                                                                                                  |
| `60` | `INSPECT_DIR_EXISTS`    | `--inspect` requested a directory that already exists and `--force` was not given.                                                     | Spec edge case "Inspection directory already exists".                                                                                                    |

## Mode-independent

These codes are emitted regardless of whether the command was invoked in text mode or `--json` mode. In `--json` mode the structured error body is written to stderr (FR-039 reserves stderr for diagnostics under `--json`); the exit code is the machine-actionable signal.

## Forward-compatibility

New failure categories MAY claim new code numbers (next-available within the gapped ranges above). Existing codes MUST NOT be reassigned. The gaps (12–19, 21–29, 31–39, 42–49, 51–59, 61–69, 70+) are intentional reservation space.

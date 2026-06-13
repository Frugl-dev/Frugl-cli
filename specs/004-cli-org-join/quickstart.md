# Quickstart: frugl-cli org membership (`004-cli-org-join`)

**Feature**: 004-cli-org-join | **Date**: 2026-05-24

This walkthrough is for two audiences:

1. **Contributors** — implementing/iterating on `frugl join` and the org-aware `whoami` / `upload` flows against the sibling `frugl/` Docker stack.
2. **Verifiers** — confirming the onboarding gate, the typed-error rendering, the idempotent re-join, and the no-plaintext-code-leakage invariant before trusting the command.

It assumes the `001-cli-ingest-client` foundation is already in place (oclif commands, `src/cloud/`, `src/lib/exit-codes.ts`, keychain). For the broader CLI setup, see `specs/001-cli-ingest-client/quickstart.md` — only the org-specific additions are covered here.

---

## 1. Prerequisites

- Everything from `specs/001-cli-ingest-client/quickstart.md` §1 (Node ≥ 20, pnpm, Docker, a working OS credential store).
- The cloud stack must include the `003-org-membership-permissions` endpoints (`POST /api/join`, `GET /api/orgs/me`) and the dashboard's invite-code generation. Bring the stack up from the sibling `frugl/` repo:

```bash
cd ~/Documents/frugl/frugl
pnpm stack:up      # Supabase + object store + web app, incl. the 003 org endpoints
```

The stack listens on `http://localhost:54321`. Point the CLI at it:

```bash
export FRUGL_ENDPOINT=http://localhost:54321
```

`frugl join` and the org-resolution calls in `whoami`/`upload` honour `--endpoint` and `FRUGL_ENDPOINT` exactly like `frugl upload` (FR-002, spec edge case).

---

## 2. Generate an invite code (admin, on the dashboard)

Org-creation and invite generation are web-only in v1 (the CLI does not create orgs). On the local dashboard:

1. Log in as a founder account and create an Organization (e.g. "Acme Corp", slug `acme`) — cloud spec 003 US1.
2. As the org Owner/Admin, generate an invite code (cloud spec 003 US2). Copy it, e.g. `ACME-XKLM-7P3R`.

You now have a code to redeem from a _second_ account via the CLI.

---

## 3. The join happy path (US1)

In a clean shell, logged in as a _different_ account (run `frugl login` first):

```bash
frugl login                          # OTP via @inquirer/prompts; token → OS keychain (001)
frugl join ACME-XKLM-7P3R
# ✓ Joined Acme Corp (acme) as member.
#   You can now run `frugl upload` to send sessions to this organization.
echo $?                              # 0
```

The CLI normalises the code (uppercase, strip whitespace + separators), validates the base32-Crockford alphabet + length locally, then `POST`s `{ "code": "ACMEXKLM7P3R" }` with the bearer token. Mixed case / extra whitespace / missing hyphens all normalise to the same value (US1 scenario 2):

```bash
frugl join "acme xklm7p3r"           # same normalised code, same result
```

**Verify server-side** (against the local Supabase):

```sql
-- a memberships row exists for the second account, at the code's role
SELECT role FROM memberships WHERE user_id = '<second-account-uuid>';
-- the invitation's used_count incremented by exactly 1
SELECT used_count FROM invitations WHERE code_hash = encode(sha256('ACMEXKLM7P3R'::bytea), 'hex');
```

---

## 4. Idempotent re-join (US1 scenario 4 / SC-004)

Re-running the same join for an org you already belong to is a no-op success:

```bash
frugl join ACME-XKLM-7P3R
# You are already a member of Acme Corp.
echo $?                              # 0  ← exit 0, even though the wire status is 409 already_member
```

This is the one case where a non-2xx status maps to exit 0 (research.md R-2 / FR-017).

---

## 5. The auth + typed-error paths (US2 / US3)

**No token (US2)** — on a clean machine with no `frugl` token, zero network requests are made:

```bash
frugl join ANY-VALID-FORMAT-CODE
# You're not signed in. Run `frugl login` first, then re-run this command.
echo $?                              # 10 (AUTH_FAILURE)
```

**Typed redemption errors (US3)** — each renders one actionable message + one exit code. Exercise them with codes the local stack rejects (revoke / expire / exhaust a code on the dashboard, or type a non-existent one):

| Scenario                                     | Message                                                              | `echo $?` |
| -------------------------------------------- | -------------------------------------------------------------------- | --------- |
| Typo / never issued (`404 not_found`)        | "Invite code not recognised. Check for typos…"                       | 70        |
| Expired (`410 expired`)                      | "This invite code has expired. Ask the admin for a new one."         | 70        |
| Revoked (`410 revoked`)                      | "This invite code has been revoked…"                                 | 70        |
| Exhausted (`410 exhausted`)                  | "This invite code has reached its usage limit…"                      | 70        |
| Already in a different org (`409 wrong_org`) | "You are already a member of `<Beta Inc>`. Leave that organization…" | 71        |
| Rate-limited (`429`)                         | "Too many join attempts. Try again in N seconds."                    | 72        |

The `wrong_org` message interpolates the current + target org names from the response `details` (FR-018). The `429` seconds come from the `Retry-After` header (FR-014); the CLI does **not** auto-retry.

**Local malformed code** — rejected before any network call:

```bash
frugl join 'NOT*A*CODE'
# Invite code contains unexpected characters.
echo $?                              # 2 (USAGE)
```

---

## 6. `frugl whoami` org awareness (US4 / SC-007)

After joining:

```bash
frugl whoami
# Signed in as dev@acme.com
# Organization: Acme Corp (acme) — 7 members
# Your role: member
echo $?                              # 0
```

A logged-in account that has **not** joined or created an org:

```bash
frugl whoami
# Signed in as newdev@example.com
# Not a member of any organization yet.
#   Run `frugl join <code>` with an invite from your org admin,
#   or create an organization at https://frugl.app.
echo $?                              # 0  ← no-org is a reported state, not a failure (FR-025)
```

Machine-readable:

```bash
frugl whoami --format json | jq '.organization'
# { "id": "...", "name": "Acme Corp", "slug": "acme", "member_count": 7, "role": "member" }
# or: null   (when no Membership)
```

---

## 7. `frugl upload` onboarding gate (US5 / SC-008)

A logged-in account with **no** Membership is stopped before any work:

```bash
frugl upload
# You haven't joined an organization yet, so there's nowhere to upload to.
#   Run `frugl join <code>` with an invite from your org admin,
#   or create an organization at https://frugl.app, then re-run `frugl upload`.
#
# No sessions were discovered, anonymized, or transmitted.
echo $?                              # 12 (ORG_REQUIRED)
```

The gate fires for `--dry-run` too (a dry run needs a real destination to be honest, FR-028):

```bash
frugl upload --dry-run
echo $?                              # 12 (ORG_REQUIRED) — no inspection dir written
```

**Verify zero work** against a recording mock server: assert no presign/manifest/`PUT` calls and zero bytes transmitted (SC-008). The org-context call (`GET /api/orgs/me`) happens **before** discovery + anonymization, so this is structural, not best-effort (research.md R-7).

---

## 8. `frugl upload` names the destination (US6 / SC-009)

For a member of an org, the pre-upload summary names where the batch is going:

```bash
frugl upload
# Uploading to: Acme Corp (acme) — your role: member
# Discovered 52 sessions: 47 unchanged (skipping), 3 new, 2 updated. Will upload 5 sessions, ~22 MB redacted.
# Redaction policy: v0.1. Destination: http://localhost:54321
# Proceed? [y/N]
```

Under `--confirm` / `--yes`, the destination is still emitted (stderr in text mode, the `upload-start` event in `--json`) so non-interactive runs record where the batch went:

```bash
frugl upload --confirm --format json | jq -c 'select(.event=="upload-start") | .organization'
# { "id": "...", "slug": "acme" }
```

---

## 9. Verify the trust gate is untouched

`frugl join` processes **no** session data — the anonymizer is out of its scope (FR-023), and the `redaction_policy_version` never appears in the `/api/join` body. The upload org-gate fires **before** anonymization, so it can never weaken the trust gate. Confirm the join request body carries only `{ "code": … }`:

```bash
# point at a recording mock server and assert the POST /api/join body is exactly {"code":"..."}
# — no org_id, no redaction_policy_version, nothing else.
```

---

## 10. No-plaintext-code leakage (SC-005)

The invite code is secret material. At the default log level it appears only in the request body, never in output:

```bash
frugl join ACME-XKLM-7P3R 2>&1 | grep -F 'ACME' && echo "LEAK" || echo "ok — code not echoed"
# ok — code not echoed   (the success message names the ORG, not the code)
```

`--debug` may include the code; docs warn debug output can contain secrets (FR-006).

---

## 11. End-to-end loop (the SC-001 scenario)

With the stack up and an admin-generated code in hand, time the full onboarding:

```bash
export FRUGL_ENDPOINT=http://localhost:54321
time (
  frugl login &&            # → OK (001)
  frugl join "$CODE" &&     # → ✓ Joined …, exit 0, < 30 s total (SC-001)
  frugl whoami &&           # → names the org + role, exit 0 (SC-007)
  frugl upload --confirm    # → names destination, uploads (SC-009)
)
```

All exit codes are documented in `contracts/exit-codes.md` (additions) and `specs/001-cli-ingest-client/contracts/exit-codes.md` (base). Branch on the code, not the prose.

---

## 12. Where things live (delta from `001`)

| Concern                                              | Path                                               |
| ---------------------------------------------------- | -------------------------------------------------- |
| `frugl join` command                                 | `src/commands/join.ts`                             |
| Org-aware `whoami` / `upload`                        | `src/commands/whoami.ts`, `src/commands/upload.ts` |
| `POST /api/join` transport wrapper                   | `src/cloud/join.ts`                                |
| `GET /api/orgs/me` transport wrapper                 | `src/cloud/orgs.ts`                                |
| New cloud zod schemas                                | `src/cloud/schemas.ts`                             |
| Code normalization + local validation (pure)         | `src/join/normalize.ts`, `src/join/validate.ts`    |
| New exit codes + typed errors                        | `src/lib/exit-codes.ts`, `src/lib/errors.ts`       |
| Destination line in the pre-upload summary           | `src/upload/summary.ts`                            |
| Public contracts (join, orgs-me, exit codes, --json) | `specs/004-cli-org-join/contracts/`                |

For the broader CLI, the spec is `specs/004-cli-org-join/spec.md` and the plan is `specs/004-cli-org-join/plan.md`.

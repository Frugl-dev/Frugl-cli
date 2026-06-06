# Quickstart: CLI-to-Web Session Handoff

**Feature**: 006-cli-web-session-handoff | **Date**: 2026-06-06

Contributor and verifier walk-through. Assumes the 001 quickstart works for you (local
Docker stack from the sibling `frugl/` repo, `frugl login` against it).

## What this feature does

After a successful `frugl upload`, the printed dashboard link signs you in to the web app
automatically — once, within ~60 seconds — instead of dropping you on a login wall.

```text
✔ Uploaded 12 sessions.
  Dashboard: http://localhost:4321/dashboard/uploads/mfst_abc?handoff=hof_9f2c…
             (link signs you in — expires in ~60s; afterwards you'll log in normally)
```

## Verify the happy path (P1)

1. Bring up the local stack: `cd ../frugl && pnpm stack:up`
2. `frugl login --endpoint http://localhost:4321` (email + OTP via Inbucket)
3. `frugl upload --endpoint http://localhost:4321 --yes`
4. Open the printed link **in a fresh private browser window** (no existing web session).

**Expected**: you land on the upload's dashboard page, signed in as your CLI account, with
zero prompts, and the address bar shows the URL **without** the `?handoff=` parameter.

## Verify single-use + expiry (P2)

- Open the same link a second time → web login appears; after logging in you land on the
  same dashboard page (deep link preserved).
- Run another upload, wait > 60 s, then open the link → same login-then-deep-link behavior.

## Verify graceful degradation (P2)

Point at a cloud without the endpoint (or kill the stack between complete and handoff —
simplest is a unit-level check, but for a live check use any deployed cloud predating
handoff):

```sh
frugl upload --yes
```

**Expected**: upload reports success exactly as before, plain dashboard URL, exit code
unchanged, one dim note that the sign-in link is unavailable. Never an error, never a retry
delay > 3 s.

## Verify the opt-out surface (P3)

```sh
frugl upload --yes --no-handoff        # plain URL, no issuance request on the wire
frugl upload --yes --json              # default off: no `handoff` key, plain dashboardUrl
frugl upload --yes --json --handoff    # opt-in: dashboardUrl carries ?handoff=,
                                       # summary contains {"handoff":{"active":true,...}}
frugl upload --yes 2>&1 | cat          # piped stdout (non-TTY) → default off
```

`--dry-run` and "nothing to upload" runs never mint codes regardless of flags.

## Where the code lives

| Concern                                    | Location                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| Issuance call, URL decoration, degradation | `src/cloud/handoff.ts` (new)                                 |
| Wire schemas (drift sentinel)              | `src/cloud/schemas.ts`                                       |
| Flag + invocation + output                 | `src/commands/upload.ts`                                     |
| Consumer contract on the cloud             | `specs/006-cli-web-session-handoff/contracts/handoff-api.md` |

## Test suites

```sh
pnpm vitest run src/cloud/handoff.test.ts   # unit: precedence, degradation, decoration
pnpm vitest run                             # full gate (pre-commit runs this anyway)
```

Integration coverage of redemption (signed-in landing, single-use, expiry, deep-link
preservation) runs against the Docker stack and lands with the cloud-side implementation —
tracked as a cross-repo task in `../frugl`.

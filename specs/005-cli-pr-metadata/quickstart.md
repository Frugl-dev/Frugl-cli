# Quickstart: frugl-cli PR-link metadata (`--link-prs`)

**Feature**: 005-cli-pr-metadata | **Date**: 2026-05-24

This walkthrough is for **trust-gate verifiers** and **contributors**. It proves the four guarantees that make this opt-in feature safe:

1. **Default-off sends nothing** — without `--link-prs`, no repository is read and no git field leaves the machine (SC-001).
2. **Opt-in attaches the correct context** — with `--link-prs`, each session in a real repo carries the right `owner/name`, branch, and commit (SC-002).
3. **Auditable before send** — `--link-prs --dry-run --inspect` shows the exact metadata and transmits zero bytes (SC-004).
4. **Credentials never leak** — a token embedded in a remote URL appears nowhere in the manifest, summary, or inspection output (SC-003).

Prerequisites are the same as `001` (`specs/001-cli-ingest-client/quickstart.md`): Node ≥ 20, pnpm, the local Docker stack from the sibling `frugl/` repo, and a working OS keychain. Bring up the stack and `pnpm dev login` exactly as in `001` §4–5 before the steps below.

---

## 1. Default is off — prove nothing git-related leaves the machine (SC-001, FR-001/002)

Run a normal upload, with **no** new flag, from inside a git repository:

```bash
cd ~/Documents/frugl/frugl-cli         # a real git checkout with a GitHub origin
export FRUGL_ENDPOINT=http://localhost:54321

pnpm dev upload --dry-run --inspect ./out-default
```

Confirm the default path is byte-for-byte `001`:

```bash
# The summary says PR linking is off (or omits the git line entirely):
pnpm dev upload --dry-run 2>&1 | grep -i "PR linking"
#   → "PR linking: off"   (or no git line at all)

# No git field anywhere in the inspection output, even though we ran inside a repo:
rg -i 'gitContext|"branch"|"commitSha"|"repository"|github\.com' ./out-default/   # → zero hits
```

The automated guarantee (SC-001) is stronger than grep: the integration test points a session's `cwd` at a real repo, runs `upload` **without** `--link-prs`, and asserts via a filesystem spy that **no `.git` path was read** and via a network spy that **no request body contains a git field**. The resolver is never even entered on the default path (research.md R-7, data-model.md §3).

---

## 2. Opt in — attach correct context (SC-002, FR-004/005/006/007/010)

```bash
pnpm dev upload --link-prs --dry-run --inspect ./out-linked
```

Inspect one session's git context (written distinctly from the redacted payload — see §3):

```bash
cat ./out-linked/git-context.json        # or the per-session gitContext block
```

Expected, for a session worked in this repo on branch `005-cli-pr-metadata`:

```jsonc
{
  "<sessionId>": {
    "repository": { "host": "github.com", "owner": "<you>", "name": "frugl-cli" },
    "branch": "005-cli-pr-metadata",
    "commitSha": "…40-hex HEAD…",
  },
}
```

Checks:

- `owner/name` matches `git config --get remote.origin.url` (host + path), credential-stripped.
- `branch` matches the branch the **session** recorded (`gitBranch` in the JSONL), which may differ from the repo's current branch (FR-006). On a detached-HEAD checkout, `branch` is omitted and `commitSha` is still present (spec Edge Cases).
- `commitSha` equals the repo's current `HEAD` (`git rev-parse HEAD`) — full 40-hex.

The pre-upload summary (FR-013) names the repositories and counts:

```
PR linking:         on (from flag)
Git context:        4 of 5 sessions
  repos:            acme/widgets, acme/api
```

---

## 3. Audit before send — `--dry-run --inspect` shows it, transmits nothing (SC-004, FR-014)

```bash
pnpm dev upload --link-prs --dry-run --inspect ./out-audit
```

- Every git-context value that **would** be transmitted is present in `./out-audit/` (SC-004: 100% coverage).
- Zero bytes are sent. The dry-run path returns before any cloud call (`001` FR-018); the automated test asserts a network spy records **zero** upload-endpoint hits.
- The inspection output presents git context **distinctly** from the redacted payload (FR-014 / US3 scenario 3): the redacted `*.payload.json` files are the anonymized content; the `git-context.json` (or per-session `gitContext` block) is clearly labelled "intentionally sent in clear — opt-in, NOT redacted." This keeps the "redacted vs. sent-in-clear" distinction unambiguous.

---

## 4. Credentials never leak — fail-closed stripping (SC-003, FR-005/015)

Set up a repo whose `origin` embeds a token, then verify it is stripped:

```bash
# In a throwaway clone, plant a credential in the remote URL:
git remote set-url origin "https://x-access-token:PLANTED_TOKEN_abc123@github.com/acme/widgets.git"

# Run a session recorded with cwd inside that repo:
pnpm dev upload --link-prs --dry-run --inspect ./out-cred

# The planted token must appear NOWHERE:
rg --hidden 'PLANTED_TOKEN_abc123' ./out-cred/        # → zero hits
pnpm dev upload --link-prs --dry-run 2>&1 | rg 'PLANTED_TOKEN_abc123'   # → zero hits (summary)
```

- The recorded repository identity is `github.com` + `acme/widgets` only — host + `owner/name`, no token (FR-005, US1 scenario 3).
- If the remote URL **cannot** be parsed into a clean host + `owner/name`, the CLI records **no** repository identity (fail-closed) rather than risk an unsanitised string — that session simply carries no git context.
- The automated guarantee (SC-003) runs a fixture of credential-bearing URLs (https-with-token, ssh-with-user, scp-style) and asserts 0% contain any credential substring and 100% are host + `owner/name`.

---

## 5. No ledger churn — toggling the flag does not re-upload (SC-007, FR-011)

```bash
pnpm dev upload --confirm                 # first upload, no flag
pnpm dev upload --link-prs --confirm      # re-run WITH the flag
#   → the previously-uploaded, unchanged sessions are classified `unchanged` and SKIPPED.
#     They do NOT retroactively gain git context, and they are NOT re-uploaded.
```

Why: git context is manifest metadata, excluded from the redacted-payload `contentHash` the ledger keys on (FR-011). Toggling `--link-prs` cannot change that hash, so an otherwise-unchanged session stays `unchanged` (data-model.md §5, contracts/manifest-gitcontext.md §4). Git context attaches only to the `(new ∪ updated)` batch — no retroactive backfill (spec Assumptions). The automated test (SC-007) uploads without the flag, re-runs with it, and asserts the session classifies `unchanged` and is skipped.

---

## 6. Best-effort over a messy backlog (SC-005, FR-008/009)

```bash
pnpm dev upload --link-prs --confirm
```

Over a real month of sessions — some in clean repos, some in scratch dirs, some in a repo since deleted, some detached-HEAD, some with no remote — the command:

- attaches git context where it can,
- silently omits it where it can't (no per-session warning spam),
- **never drops** a session's payload upload because its git context failed to resolve,
- exits **success**.

Two global notices, each emitted at most once, exit success:

- "PR linking was on, but no sessions had resolvable git context" — when nothing resolved (US4 scenario 4).
- "PR linking was on, but git could not be inspected; proceeding as if --link-prs were off" — when git is unavailable on the host (US4 scenario 5 / FR-009).

No new exit code is introduced (spec Assumptions).

---

## 7. Persisted opt-in (optional, FR-003)

Instead of passing `--link-prs` every run, persist the preference (defaults to off):

```bash
pnpm dev config set linkPrs true     # exact surface per implementation; default false
pnpm dev upload --confirm            # PR linking now on via config
pnpm dev upload --link-prs --confirm # explicit flag always wins over config (FR-003)
```

The summary's "PR linking: on (from config)" / "on (from flag)" line shows which source enabled it. The persisted setting holds only the boolean — never any repository data.

---

## 8. Where things live

| Concern                                    | Path                                                       |
| ------------------------------------------ | ---------------------------------------------------------- |
| Git-context resolver (the auditable core)  | `src/upload/git-context.ts`                                |
| Credential-strip + degradation tests       | `src/upload/git-context.test.ts`                           |
| Opt-in flag + orchestration                | `src/commands/upload.ts`                                   |
| Source surfacing `cwd` / `gitBranch`       | `src/sources/claude-code/parse.ts`, `src/sources/types.ts` |
| Pre-upload summary (audit before send)     | `src/upload/summary.ts`                                    |
| Manifest metadata attach (outside payload) | `src/upload/pipeline.ts`, `src/cloud/schemas.ts`           |
| `--json` additive fields                   | `src/upload/progress.ts`                                   |
| Persisted opt-in config                    | `src/lib/config.ts`                                        |
| Public contract                            | `specs/005-cli-pr-metadata/contracts/`                     |

The spec is `specs/005-cli-pr-metadata/spec.md` and the plan is `specs/005-cli-pr-metadata/plan.md`.

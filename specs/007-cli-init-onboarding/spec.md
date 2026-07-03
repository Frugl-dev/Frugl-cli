# Feature Specification: `frugl init` — one-command onboarding + `.frugl.json`

**Feature Branch**: `feat/cli-init-command`

**Created**: 2026-06-29

**Status**: Draft

**Input**: User request: "Can we set the CLI to have just one command to configure
everything (e.g. `frugl login --upload --context -y`)? With `init` we likely want
to create a `.frugl.json` file. What conventions should we put into that file?"

## Summary

Today a first-time user runs three commands in sequence — `frugl login`
(or `frugl setup`), `frugl upload`, `frugl snapshot` — and nothing records the
project's choices (endpoint, org, upload scope) for the next run. This feature
adds a single front-door command, **`frugl init`**, that authenticates, sets up
an org, **writes a project-local `.frugl.json`**, runs the first upload and
snapshot, and prints the dashboard link — in one pass, with a `--yes`
non-interactive mode.

`.frugl.json` becomes the **single, committable, project-level config file**. It
subsumes the two project files that exist today: the self-host endpoint pin
(`.frugl.json` with only `{ endpoint }`) and the upload-scope config
(`frugl.config.json`). The latter stays readable as a **deprecated fallback** so
no existing repo breaks.

## Decisions (locked)

1. **Consolidate into `.frugl.json`.** One project config file: `endpoint`, `org`,
   and an `upload` block. `frugl.config.json` is still read when `.frugl.json`
   carries no upload config, but is documented as deprecated. (Rejected:
   keeping two files; introducing a third `frugl.json`.)
2. **`init` wraps `setup`'s internals.** The auth + org-setup flow is extracted
   into one shared helper that both `setup` and `init` call. `init` then adds
   config-write + upload + snapshot. `setup` keeps its current behavior.
3. **Secrets never go in `.frugl.json`.** The auth token stays in the OS keychain
   / global config exactly as today. `.frugl.json` is safe to commit; `init`
   never writes a token into it and never auto-gitignores it.
4. **Endpoint keeps fail-closed pin semantics.** `.frugl.json` only acts as a
   self-host pin when the `endpoint` key is **present**. A `.frugl.json` that has
   `org`/`upload` but no `endpoint` is NOT a pin and falls through to the normal
   `env ?? saved ?? default` resolution — so writing config for a cloud user
   never silently locks them to a stale endpoint.

## User Scenarios & Testing _(mandatory)_

### User Story 1 — One command sets everything up (Priority: P1)

A brand-new user installs the CLI and runs `frugl init`. They are prompted to
sign in (email OTP), to create or join an org, and the command then writes a
`.frugl.json` at the cwd, uploads their qualifying sessions, captures a context +
MCP snapshot, and prints the dashboard link. Every later `frugl upload` /
`frugl snapshot` in that directory reuses the recorded endpoint, org, and upload
scope.

**Why this priority**: This is the feature. It collapses the three-step,
nothing-remembered onboarding into one guided pass and leaves behind a config
that makes subsequent runs deterministic.

**Independent Test**: In a temp dir with seeded sessions and no prior login, run
`frugl init`, complete the OTP + org prompts, and confirm: (a) `.frugl.json` is
written with `org` set, (b) sessions uploaded, (c) snapshot captured, (d)
dashboard URL printed, (e) a follow-up `frugl upload` finds and respects the
written config.

**Acceptance Scenarios**:

1. **Given** an unauthenticated user in a project dir, **When** they run
   `frugl init` and complete the prompts, **Then** they are signed in, an org is
   created or joined, `.frugl.json` is written, the first upload + snapshot run,
   and the dashboard link is printed.
2. **Given** a successful `init`, **When** the user later runs `frugl upload` in
   the same dir, **Then** the org and upload scope from `.frugl.json` are applied
   without re-passing flags.
3. **Given** a user already signed in with a saved session, **When** they run
   `frugl init`, **Then** the auth step is skipped (no OTP prompt) and the flow
   continues to org + config + upload + snapshot.

### User Story 2 — Non-interactive `init` for scripts/CI (Priority: P1)

A user (or a provisioning script) runs `frugl init --yes` with the inputs it
needs supplied as flags (`--email`, `--org-name` or `--invite-code`,
`--min-cost`, `--endpoint`). No interactive prompts appear; defaults are accepted
for anything not specified; the command writes `.frugl.json` and completes the
upload + snapshot.

**Why this priority**: The original ask explicitly includes the `-y` shape. A
one-command onboarding that can't run unattended is half a feature.

**Independent Test**: Run `frugl init --yes --org-name "Acme" --min-cost 5` with a
pre-seeded session (auth supplied via `FRUGL_TOKEN`) and assert it completes with
no prompt, writes `.frugl.json`, and exits 0.

**Acceptance Scenarios**:

1. **Given** `--yes` and all required inputs as flags, **When** `init` runs,
   **Then** no interactive prompt is shown and the command completes.
2. **Given** `--yes` but a missing required input (e.g. no auth and no
   `--email`), **When** `init` runs, **Then** it fails fast with a clear usage
   error rather than hanging on a prompt.
3. **Given** `--no-upload` and/or `--no-snapshot`, **When** `init --yes` runs,
   **Then** those steps are skipped but `.frugl.json` is still written.

### User Story 3 — Re-running `init` is safe and non-destructive (Priority: P2)

A user re-runs `frugl init` in a directory that already has a `.frugl.json`. The
command merges — it fills only the keys it manages, preserves any other keys, and
prompts before overwriting a conflicting value (skipped under `--yes`/`--force`).
Re-running with no changes produces no diff.

**Why this priority**: `init` will be re-run (to add an org, re-point an
endpoint, refresh after a reset). It must never silently clobber a hand-edited
config or churn the file.

**Independent Test**: Write a `.frugl.json` with a custom `upload.minCost` and an
unknown future key, run `frugl init --yes`, and assert the custom value and the
unknown key survive and the file is byte-stable on a second run.

**Acceptance Scenarios**:

1. **Given** an existing `.frugl.json`, **When** `init` writes, **Then** keys it
   does not manage are preserved verbatim.
2. **Given** an existing value that conflicts with a new one, **When** `init`
   runs interactively, **Then** it prompts before overwriting; under
   `--yes`/`--force` it overwrites without prompting.
3. **Given** no effective change, **When** `init` runs twice, **Then** the second
   run leaves the file byte-for-byte identical (stable key order, trailing
   newline).

## `.frugl.json` conventions _(the file contract)_

```jsonc
{
  // Editor autocomplete + validation. Points at a static, versioned schema.
  "$schema": "https://app.frugl.dev/schema/frugl.v1.json",
  // Integer file-format version. Lets the CLI migrate/refuse future formats.
  "version": 1,
  // Self-host endpoint pin. PRESENT → fail-closed pin (overrides env/saved/
  // default, never falls back to public cloud, loses only to an explicit
  // --endpoint flag). ABSENT → not a pin; normal endpoint resolution applies.
  "endpoint": "https://app.frugl.dev",
  // Active org slug to upload under.
  "org": "acme",
  // Upload scope + options. All keys optional; absent = sensible default.
  "upload": {
    "enabled": true, // false disables upload for this repo entirely
    "auto": false, // true skips the confirm prompt and auto-runs snapshot after
    "minCost": 10.0, // USD floor, mirrors --min-cost (floored at 10)
    "snapshot": true, // run snapshot as part of init
    "concurrency": 4, // per-session upload concurrency
    "linkPrs": false, // attach stripped git context for PR linking
    "providers": ["claude-code"], // dashed source_kind ids; absent = all supported
  },
}
```

There is no `projects`/include-exclude field: a `.frugl.json`'s mere presence in
a directory **is** the project declaration. `frugl upload` / `frugl snapshot`
scope themselves to the directory containing the nearest `.frugl.json` (and
everything nested under it, e.g. worktrees) — a glob would have to encode an
absolute, machine-local path, which breaks the moment a teammate clones the
repo somewhere else. (The deprecated `frugl.config.json` fallback still
supports `projects.include`/`exclude` globs for back-compat; it predates this
file and is not part of this contract.)

Conventions:

- **Filename** `.frugl.json` at the project root; discovery walks up from cwd to
  the git root / `$HOME` (matches `tsconfig.json`/`.eslintrc`). `FRUGL_CONFIG`
  may override discovery.
- **`$schema` + `version`** always written; `version` starts at `1`.
- **Grouped by concern** (`upload.*`) rather than flat keys, leaving room for
  future `snapshot.*` / `auth.*` blocks.
- **`providers`** use the dashed `source_kind` spelling (`claude-code`), matching
  ingestion — not the underscore provider keys.
- **No secrets, ever.** Token lives in the keychain / global config.
- **Write only non-default keys.** A value equal to the built-in default is
  omitted; resolution fills it at read time. Keeps the file small and "what did I
  customize" obvious.
- **Stable serialization**: fixed key order, two-space indent, trailing newline —
  so re-running `init` yields no spurious diff.
- **Fail-closed read**: a present-but-malformed `.frugl.json` (bad JSON, schema
  violation) throws rather than being ignored — same posture as today's pin. The
  ONE tolerated exception is the **legacy endpoint-only pin**: a pre-v1
  `.frugl.json` whose only key is `endpoint` (no `version`) is read as "no v1
  project config" (null), not an error, so existing self-host repos that pin only
  an endpoint keep working with `frugl upload` (the endpoint still resolves via
  the bare pin reader). Anything else without `version: 1` — including `endpoint`
  alongside other keys — is treated as a real, corrupt config and still throws.

## Resolution precedence (unchanged, now centered on `.frugl.json`)

```
flag  ??  env (FRUGL_*)  ??  .frugl.json  ??  global config (saved)  ??  built-in default
```

- Endpoint: `--endpoint` ?? `.frugl.json#endpoint` (pin) ?? `FRUGL_ENDPOINT` ??
  saved-login ?? default. (Already implemented; unchanged.)
- Upload scope/options: command flag ?? `.frugl.json#upload.*` ??
  `frugl.config.json` (deprecated) ?? default.

## Requirements _(mandatory)_

- **FR-001** A `frugl init` command exists and is listed in `--help`.
- **FR-002** `init` performs, in order: auth → org setup → write `.frugl.json` →
  upload → snapshot → print dashboard URL.
- **FR-003** `init` reuses the existing auth + org-setup flow (no duplicated OTP
  or org logic); `setup` and `init` share one helper.
- **FR-004** `init` skips the auth step when a valid saved session exists for the
  resolved endpoint.
- **FR-005** `--yes`/`-y` runs non-interactively: no prompts, defaults accepted,
  required-but-missing input fails fast with a usage error (never hangs).
- **FR-006** Flags `--email`, `--org-name`, `--invite-code`, `--min-cost`,
  `--endpoint`, `--no-upload`, `--no-snapshot`, `--force` are supported.
- **FR-007** `init` writes `.frugl.json` at the cwd with `$schema`, `version`,
  `org`, an `upload` block for non-default options, and `endpoint` **only** when
  the resolved endpoint is non-default (a real self-host pin) — never pinning a
  cloud user to the default.
- **FR-008** Writing merges with any existing `.frugl.json`: unmanaged keys
  preserved, default-valued managed keys omitted, stable key order + trailing
  newline, byte-stable on no-op re-run.
- **FR-009** Interactive re-run prompts before overwriting a conflicting value;
  `--yes`/`--force` overwrites silently.
- **FR-010** `init` never writes a secret/token into `.frugl.json`.
- **FR-011** A present-but-malformed `.frugl.json` fails closed (throws) on read.
  Exception: the legacy endpoint-only pin (`{ endpoint }`, no `version`) is
  tolerated as "no v1 config" (null) for back-compat — see § conventions —
  while any other keys without a valid `version: 1` still throw.
- **FR-012** `.frugl.json#upload` is honored by `frugl upload` (enabled, auto,
  minCost, concurrency, linkPrs, providers); the file's mere presence scopes
  discovery to its directory (and anything nested under it), so no
  include/exclude field exists. `frugl.config.json` remains a deprecated
  fallback, consulted only when no `.frugl.json` is found at all.
- **FR-013** `--no-upload` / `--no-snapshot` skip those steps but still write
  `.frugl.json`.
- **FR-014** Exit codes reuse the frozen dispatch (10 not-authed, 20 no sessions,
  30 anonymization, 40 network, 2 usage), surfaced via the shared error handler.
- **FR-015** Upload/snapshot failures are reported but do not prevent the
  `.frugl.json` write that already succeeded; the exit code reflects the first
  failure.

## Out of scope

- Migrating `frugl.config.json` files automatically (it stays a read fallback; a
  later release may print a deprecation hint or a `frugl config migrate`).
- Hosting the `$schema` JSON document (tracked separately; the URL is written now
  so editors can pick it up once published).
- A global `~/.frugl.json` (this feature is per-project only).
- Changing the keychain/global-config auth storage.

## Non-functional / constitution

- **Fail-closed** read of project config (Principle VI), mirroring the existing
  pin.
- **No secret in a committable file** (security posture).
- **Anonymization unchanged** — `init` calls the same upload pipeline; no new
  data path leaves the machine.

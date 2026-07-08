import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests assert against the rich `default` output format. Since `--format` is
// unset in most invocations, resolveOutputMode would otherwise fall back to
// `minimal` whenever a CI environment variable is present (e.g. when the suite
// itself runs in CI), making output env-dependent and flaky. Strip the CI
// markers here so unresolved-format runs are deterministically `default`.
// CI detection is covered explicitly by passing a fake env to isCi().
for (const key of ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "BUILDKITE", "TF_BUILD"]) {
  delete process.env[key];
}

// Suppress the "new version available" notice. It's driven by a 24h npm-registry
// cache in the developer's config dir, so on a machine that has run `frugl`
// before it writes to stderr unpredictably — silent in fresh CI, noisy on a
// real laptop — breaking exact-stderr assertions (the hook no-op, etc.).
process.env["NO_UPDATE_NOTIFIER"] = "1";

// Isolate the credential store from the developer's real OS keychain. This
// setup file runs per test file, so each file (its parent process AND any CLI
// child it spawns, which inherits process.env) gets its own hermetic JSON store
// — an injected session is readable by the spawned CLI, and an absent one reads
// as "never logged in" regardless of whether the machine is really logged in.
// keychain.test.ts deletes this to exercise the OS-keychain (Entry) path.
process.env["FRUGL_KEYCHAIN_FILE"] = join(
  mkdtempSync(join(tmpdir(), "frugl-keychain-")),
  "store.json",
);

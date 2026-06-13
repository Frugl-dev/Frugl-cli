// Tests assert against the rich `default` output format. Since `--format` is
// unset in most invocations, resolveOutputMode would otherwise fall back to
// `minimal` whenever a CI environment variable is present (e.g. when the suite
// itself runs in CI), making output env-dependent and flaky. Strip the CI
// markers here so unresolved-format runs are deterministically `default`.
// CI detection is covered explicitly by passing a fake env to isCi().
for (const key of ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "BUILDKITE", "TF_BUILD"]) {
  delete process.env[key];
}

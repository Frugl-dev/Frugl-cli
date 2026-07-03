// The provider-agnostic surface of the hook feature. Each supported AI tool
// (Claude Code, Codex, Gemini, Cursor) ships one HookProvider that knows where
// its config lives and how to write our entry into it; the commands iterate the
// registry and never touch provider formats directly.

export type HookScope = "project" | "global";

export interface HookFsOptions {
  cwd?: string;
  home?: string;
}

export type HookProviderId = "claude" | "codex" | "gemini" | "cursor";

// "conflict" is a first-class outcome, not an error: Codex's `notify` key is a
// single slot, so a foreign value means we must refuse (never clobber another
// tool's automation) while still letting the other providers install.
export type HookInstallResult =
  | { status: "installed"; path: string }
  | { status: "conflict"; path: string; reason: string };

export interface HookProvider {
  id: HookProviderId;
  displayName: string;
  // Codex config.toml is machine-global; there is no project-scoped notify.
  supportsProjectScope: boolean;
  // The tool is present on this machine (its home config dir exists). Gates the
  // default install set; an explicit --providers request overrides it.
  detect(opts?: HookFsOptions): boolean;
  configPath(scope: HookScope, opts?: HookFsOptions): string;
  isInstalled(scope: HookScope, opts?: HookFsOptions): boolean;
  install(scope: HookScope, opts?: HookFsOptions): HookInstallResult;
  uninstall(scope: HookScope, opts?: HookFsOptions): { path: string; removed: boolean };
}

// The command every provider hook runs. `hook run` is a fast, always-exit-0
// preflight that detaches the real upload — so even providers whose hooks block
// (Gemini runs SessionEnd synchronously) never make the user wait on a network
// call. Match both the current command and the legacy direct-upload entry so
// installs replace pre-`hook run` entries and uninstall removes either.
export const HOOK_RUN_COMMAND = "frugl hook run";
export const HOOK_RUN_ARGV = ["frugl", "hook", "run"] as const;
export const FRUGL_HOOK_COMMAND_RE = /\bfrugl\s+(?:hook\s+run|upload)\b/;

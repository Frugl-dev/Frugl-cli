import { Command, Flags } from "@oclif/core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import { color, symbol } from "../lib/theme.js";
import { getProfile, type Profile } from "../lib/config.js";
import { loadProjectPin } from "../cloud/project-pin.js";
import {
  findProjectConfigDir,
  PROJECT_CONFIG_DEFAULTS,
  PROJECT_CONFIG_FILENAME,
  readProjectConfig,
  type ProjectConfig,
} from "../config/project-config.js";
import { loadUploadConfig } from "../config/upload-config.js";
import {
  detectProviders,
  getProvider,
  getSourceByKind,
  PROVIDERS,
  type ProjectGroup,
} from "../sources/providers.js";

// A single resolved setting: the effective value, whether it came from the
// `.frugl.json` (source "config") or the built-in default (source "default").
interface ResolvedSetting {
  value: unknown;
  source: "config" | "default";
}

function resolve<T>(configured: T | undefined, fallback: T): ResolvedSetting {
  return configured === undefined
    ? { value: fallback, source: "default" }
    : { value: configured, source: "config" };
}

// The complete resolved `upload.*` / `snapshot.*` surface, each key labeled with
// where its effective value came from. Mirrors the managed keys in
// project-config.ts so `config` shows exactly what `upload`/`snapshot` will act on.
function resolveSettings(config: ProjectConfig | null): Record<string, ResolvedSetting> {
  const up = config?.upload;
  const snap = config?.snapshot;
  const d = PROJECT_CONFIG_DEFAULTS;
  return {
    "upload.enabled": resolve(up?.enabled, d.upload.enabled),
    "upload.auto": resolve(up?.auto, d.upload.auto),
    "upload.minCost": resolve(up?.minCost, d.upload.minCost),
    "upload.snapshot": resolve(up?.snapshot, d.upload.snapshot),
    "upload.concurrency": resolve(up?.concurrency, d.upload.concurrency),
    "upload.linkPrs": resolve(up?.linkPrs, d.upload.linkPrs),
    "snapshot.enabled": resolve(snap?.enabled, d.snapshot.enabled),
  };
}

// A repo that has opted into Frugl by carrying its own (or an ancestor's)
// `.frugl.json`. This is what `config` reports as "the repos Frugl is using".
interface RepoRow {
  displayName: string;
  providerId: string;
  sessionCount: number;
  /** Absolute path to the `.frugl.json` that governs this repo. */
  configPath: string;
}

interface RepoScan {
  /** Provider ids present on this machine (supported + detected). */
  detectedProviderIds: string[];
  /** Provider ids the current config would actually upload from. */
  targetedProviderIds: string[];
  /** Repos (with AI sessions) that have a governing `.frugl.json`. */
  repos: RepoRow[];
}

// The fully-assembled readout handed to both renderers, so the human and JSON
// paths can never drift on what they were given.
interface ConfigView {
  endpoint: { url: string; resolvedFrom: string };
  /** The cached signed-in identity (+ last-known org), or undefined when none. */
  profile: Profile | undefined;
  projectConfig: ProjectConfig | null;
  configPath: string | null;
  pin: { endpoint: string; path: string } | undefined;
  settings: Record<string, ResolvedSetting>;
  scan: RepoScan | null;
}

export default class Config extends Command {
  static override description =
    "Show the resolved Frugl settings for this directory: the endpoint it targets, the signed-in account (from the local cache — no keychain prompt or cloud call), the project config, the providers, and the repos configured with a .frugl.json.";

  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --format json   # scriptable settings dump",
    "<%= config.bin %> <%= command.id %> --no-repos      # skip the on-disk provider/repo scan",
  ];

  static override flags = {
    repos: Flags.boolean({
      allowNo: true,
      default: true,
      description:
        "Scan the machine for AI-session providers and the repos configured with a .frugl.json (--no-repos to skip).",
    }),
    ...COMMON_FLAGS,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Config);
    // auth: "none" — `config` is a purely local readout. It never reads the OS
    // keychain (no password prompt) and never calls the cloud: the account +
    // org come from the non-secret profile cache written at login/whoami. Only
    // endpoint resolution (flag/pin/env/saved/default) runs here.
    const { mode, endpoint } = await buildCommandContext(flags, { auth: "none" });

    try {
      // Load the typed project config (fail-closed on a malformed .frugl.json —
      // the same error `upload` would hit) and its file location.
      const projectConfig = readProjectConfig();
      const configDir = findProjectConfigDir();
      const configPath = configDir ? path.join(configDir, PROJECT_CONFIG_FILENAME) : null;
      const pin = loadProjectPin();
      const settings = resolveSettings(projectConfig);

      // The signed-in identity + last-known org, from the local cache (no
      // keychain, no network). Endpoint-scoped, so a stale login on another
      // stack never shows here.
      const profile = getProfile(endpoint.url);

      const scan = flags.repos ? await this.scanRepos() : null;

      const view = { endpoint, profile, projectConfig, configPath, pin, settings, scan };
      if (mode === "json") {
        this.emitJson(view);
        return;
      }
      this.emitHuman(view);
    } catch (err) {
      handleCommandError(err, mode);
    }
  }

  // Detect providers on this machine, derive their repos, and keep only the
  // repos that have opted into Frugl by carrying a governing `.frugl.json` —
  // those are "the repos Frugl is using". The provider filter from the config
  // still narrows the *targeted* provider set (shown separately). Best-effort:
  // an on-disk scan failure degrades to null rather than failing the whole
  // readout, so `config` still shows endpoint/account/settings offline.
  private async scanRepos(): Promise<RepoScan | null> {
    try {
      const homeDir = process.env["FRUGL_HOME_DIR"];
      const discoverOpts = homeDir ? { homeDir } : undefined;

      const detected = await detectProviders(discoverOpts);
      const supportedDetected = detected.filter((d) => d.descriptor.supported);
      const detectedProviderIds = supportedDetected.map((d) => d.descriptor.id);

      const groups: ProjectGroup[] = [];
      for (const d of supportedDetected) {
        const descriptor = getProvider(d.descriptor.id);
        if (!descriptor?.supported || !descriptor.source || !descriptor.deriveProjects) continue;
        const refs = await descriptor.source.discover(discoverOpts);
        groups.push(...descriptor.deriveProjects(refs));
      }

      // Providers the current config would actually upload from: the config's
      // `upload.providers` filter intersected with what's detected, else all detected.
      const uploadConfig = loadUploadConfig();
      const targetedProviderIds = uploadConfig?.providers
        ? detectedProviderIds.filter((id) => uploadConfig.providers!.includes(id))
        : detectedProviderIds;

      // Keep only repos with a governing `.frugl.json` (the repo dir or an
      // ancestor up to $HOME) — the opt-in signal `upload.auto` keys off. The
      // repo dir is the session's true `cwd` (see resolveRepoDir), not the lossy
      // decoded group name. A group whose dir isn't a real absolute path is dropped.
      const rows: RepoRow[] = [];
      for (const g of groups) {
        const dir = await this.resolveRepoDir(g);
        const configPath = findGoverningConfig(dir);
        if (configPath) {
          rows.push({
            displayName: dir,
            providerId: g.providerId,
            sessionCount: g.sessionCount,
            configPath,
          });
        }
      }
      const repos = rows.toSorted((a, b) => a.displayName.localeCompare(b.displayName));

      return { detectedProviderIds, targetedProviderIds, repos };
    } catch {
      return null;
    }
  }

  // The true working directory of a repo group. Claude encodes a project's cwd
  // into its directory name by replacing every "/" AND "." with "-", so the
  // display decode ("-"→"/") is lossy — a real path segment containing "-" or
  // "." can't round-trip (e.g. "my-repo" decodes to "my/repo"). The reliable
  // source is the `cwd` recorded inside the session, so for Claude we read it
  // from one representative session (one file parse per repo). Other providers
  // group flat or by label rather than by a single cwd, so their displayName is
  // used as-is (and, not being an absolute path, is excluded from the repo
  // list). Falls back to the decoded displayName if the session can't be parsed.
  private async resolveRepoDir(group: ProjectGroup): Promise<string> {
    if (group.providerId !== "claude") return group.displayName;
    const ref = group.sessions[0];
    if (!ref) return group.displayName;
    const source = getSourceByKind(ref.sourceKind);
    if (!source) return group.displayName;
    try {
      const parsed = await source.parse(ref);
      return parsed.cwd && path.isAbsolute(parsed.cwd) ? parsed.cwd : group.displayName;
    } catch {
      return group.displayName;
    }
  }

  private emitJson(data: ConfigView): void {
    const profile = data.profile;
    process.stdout.write(
      `${JSON.stringify({
        command: "config",
        ok: true,
        endpoint: { url: data.endpoint.url, resolvedFrom: data.endpoint.resolvedFrom },
        // Identity from the local profile cache (no keychain / cloud). `cached:
        // true` flags that this is a last-known snapshot, not a live check.
        account: profile
          ? {
              loggedIn: true,
              cached: true,
              email: profile.email,
              userId: profile.userId,
              ...(profile.loggedInAt !== undefined ? { loggedInAt: profile.loggedInAt } : {}),
              org: profile.org
                ? { slug: profile.org.slug, name: profile.org.name, role: profile.org.role }
                : null,
              updatedAt: profile.updatedAt,
            }
          : { loggedIn: false },
        projectConfig: {
          path: data.configPath,
          // The repo-pinned org (a project setting), distinct from the account org above.
          org: data.projectConfig?.org ?? null,
          pin: data.pin ? { endpoint: data.pin.endpoint, path: data.pin.path } : null,
        },
        settings: Object.fromEntries(
          Object.entries(data.settings).map(([k, v]) => [k, { value: v.value, source: v.source }]),
        ),
        providers: {
          all: PROVIDERS.map((p) => p.id),
          detected: data.scan?.detectedProviderIds ?? null,
          targeted: data.scan?.targetedProviderIds ?? null,
        },
        // Repos that have opted in via a `.frugl.json` (null when the scan was
        // skipped, [] when none were found — the cue to run `frugl init`).
        repos:
          data.scan?.repos.map((r) => ({
            path: r.displayName,
            provider: r.providerId,
            sessions: r.sessionCount,
            configPath: r.configPath,
          })) ?? null,
      })}\n`,
    );
  }

  // Render the cached account org for the human table: name + slug + role when
  // known, else a create-an-org nudge.
  private formatOrg(org: Profile["org"]): string {
    if (org) {
      return `${color.bold(org.name)} ${color.dim(`(${org.slug})`)} ${color.dim(`· role=${org.role}`)}`;
    }
    return color.dim(`no org yet — run ${color.frog("frugl org create")}`);
  }

  private emitHuman(data: ConfigView): void {
    const out = process.stdout;
    const heading = (s: string): void => {
      out.write(`\n${color.bold(s)}\n`);
    };
    const row = (label: string, value: string): void => {
      out.write(`  ${color.dim(label.padEnd(20))}${value}\n`);
    };

    out.write(`${color.frogBold("Frugl configuration")}\n`);

    // Endpoint — the resolved target and where the value came from.
    heading("Endpoint");
    row("url", color.frog(data.endpoint.url));
    row("resolved from", color.dim(data.endpoint.resolvedFrom));
    if (data.pin) row("self-host pin", `${data.pin.endpoint} ${color.dim(`(${data.pin.path})`)}`);

    // Account — the cached identity for this endpoint (from the local profile
    // mirror; no keychain read, no cloud call).
    heading("Account");
    if (data.profile) {
      row("email", color.bold(data.profile.email));
      row("userId", color.dim(data.profile.userId));
      if (data.profile.loggedInAt) row("logged in at", color.dim(data.profile.loggedInAt));
      row("org", this.formatOrg(data.profile.org));
      row("cached", color.dim(`from last login/whoami · ${data.profile.updatedAt}`));
    } else {
      out.write(
        `  ${symbol.cross} ${color.dim("No cached identity for this endpoint. Run ")}${color.frog("frugl login")}${color.dim(" (or ")}${color.frog("frugl whoami")}${color.dim(") to populate it.")}\n`,
      );
    }

    // Project config — file location and every resolved managed setting.
    heading("Project config");
    row(
      PROJECT_CONFIG_FILENAME,
      data.configPath
        ? color.frog(data.configPath)
        : color.dim("none found — using built-in defaults"),
    );
    // The repo-pinned org (distinct from the account org shown above).
    row(
      "org (pinned)",
      data.projectConfig?.org ? color.bold(data.projectConfig.org) : color.dim("none"),
    );
    for (const [key, setting] of Object.entries(data.settings)) {
      const suffix = setting.source === "default" ? color.dim(" (default)") : "";
      row(key, `${formatValue(key, setting.value)}${suffix}`);
    }

    // Providers — which are supported, present on disk, and actually targeted.
    heading("Providers");
    row("all supported", PROVIDERS.map((p) => p.id).join(", "));
    if (data.scan) {
      row(
        "detected here",
        data.scan.detectedProviderIds.length > 0
          ? data.scan.detectedProviderIds.join(", ")
          : color.dim("none"),
      );
      row(
        "targeted",
        data.scan.targetedProviderIds.length > 0
          ? color.frog(data.scan.targetedProviderIds.join(", "))
          : color.dim("none"),
      );
    } else {
      row("detected here", color.dim("(scan skipped — pass without --no-repos to detect)"));
    }

    // Repos — the working directories that have opted into Frugl by carrying a
    // `.frugl.json`. When none are found, point the user at `frugl init`.
    heading(`Repos ${color.dim(`(with a ${PROJECT_CONFIG_FILENAME})`)}`);
    if (!data.scan) {
      out.write(`  ${color.dim("Scan skipped (--no-repos).")}\n`);
    } else if (data.scan.repos.length === 0) {
      out.write(
        `  ${symbol.warn} ${color.dim(`No repos with a ${PROJECT_CONFIG_FILENAME} found. Run `)}${color.frog("frugl init")}${color.dim(" in a repo to set one up.")}\n`,
      );
    } else {
      for (const r of data.scan.repos) {
        out.write(
          `  ${symbol.tick} ${r.displayName} ${color.dim(`— ${r.providerId} · ${r.sessionCount} session${r.sessionCount === 1 ? "" : "s"}`)}\n`,
        );
      }
    }
    out.write("\n");
  }
}

// Return the absolute path of the `.frugl.json` that governs `repoDir` — the
// file in the directory itself or the nearest ancestor up to (and including)
// $HOME — or null if none. Mirrors the cwd→home walk `readProjectConfig` uses,
// so "this repo has a config" here means the same thing `upload` would resolve.
// A non-absolute displayName (a synthetic provider label) can never match.
function findGoverningConfig(repoDir: string, home: string = homedir()): string | null {
  if (!path.isAbsolute(repoDir)) return null;
  let dir = repoDir;
  const { root } = path.parse(dir);
  for (;;) {
    const candidate = path.join(dir, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === home || dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Present a resolved value for a given key: money for minCost, JSON-ish for the
// rest. Keeps the human table readable without leaking `[object Object]`.
function formatValue(key: string, value: unknown): string {
  if (key === "upload.minCost" && typeof value === "number") return `$${value.toFixed(2)}`;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

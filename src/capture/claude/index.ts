import type { CapturedMcpServer, CapturedPlugin, ConfigCapture } from "../types.js";
import { unparsedSource } from "../types.js";
import { mergeHookSources, type HookConfigSource } from "./hooks.js";
import { defaultIO, type CaptureIO } from "./io.js";
import { parseMcpList } from "./mcp.js";
import { parsePluginList } from "./plugins.js";
import { enumerateSkillsAgents, type SkillAgentRoot } from "./skills-agents.js";

export const SOURCE_TOOL = "claude-code";

export interface AssembleOptions {
  io?: CaptureIO;
  now?: () => string;
}

// Resolve the on-disk cache root for an enabled plugin. `name@marketplace` maps
// to `<home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>`; only the
// enabled plugin's resolved version is used (research Decision 3 — no
// double-counting across cached versions).
function pluginCacheDir(io: CaptureIO, plugin: CapturedPlugin): string | null {
  const at = plugin.name.lastIndexOf("@");
  if (at <= 0) return null;
  const pkg = plugin.name.slice(0, at);
  const marketplace = plugin.name.slice(at + 1);
  const dir = io.join(
    io.homedir(),
    ".claude",
    "plugins",
    "cache",
    marketplace,
    pkg,
    plugin.version,
  );
  return io.isDir(dir) ? dir : null;
}

function readJson(io: CaptureIO, path: string): unknown | null {
  try {
    return JSON.parse(io.readFile(path));
  } catch {
    return null; // missing or invalid → honest "unreadable" signal upstream
  }
}

// The four settings layers, low→high precedence (research Decision 3).
function settingsLayerPaths(io: CaptureIO): { source: string; path: string }[] {
  const home = io.homedir();
  const cwd = io.cwd();
  return [
    { source: "user-settings", path: io.join(home, ".claude", "settings.json") },
    { source: "user-settings-local", path: io.join(home, ".claude", "settings.local.json") },
    { source: "project-settings", path: io.join(cwd, ".claude", "settings.json") },
    { source: "project-settings-local", path: io.join(cwd, ".claude", "settings.local.json") },
  ];
}

function gatherHookSources(io: CaptureIO, plugins: CapturedPlugin[]): HookConfigSource[] {
  const sources: HookConfigSource[] = [];

  for (const { source, path } of settingsLayerPaths(io)) {
    if (!fileExists(io, path)) continue; // a layer that simply isn't present
    sources.push({ source, config: readJson(io, path) });
  }

  for (const plugin of plugins) {
    if (plugin.status !== "enabled") continue;
    const dir = pluginCacheDir(io, plugin);
    if (!dir) continue;
    const path = io.join(dir, "hooks", "hooks.json");
    if (!fileExists(io, path)) continue;
    sources.push({ source: `plugin:${plugin.name}`, config: readJson(io, path) });
  }

  return sources;
}

function enabledPluginRoots(io: CaptureIO, plugins: CapturedPlugin[]): SkillAgentRoot[] {
  const roots: SkillAgentRoot[] = [{ source: "user", dir: io.join(io.homedir(), ".claude") }];
  for (const plugin of plugins) {
    if (plugin.status !== "enabled") continue;
    const dir = pluginCacheDir(io, plugin);
    if (dir) roots.push({ source: `plugin:${plugin.name}`, dir });
  }
  return roots;
}

function fileExists(io: CaptureIO, path: string): boolean {
  try {
    io.readFile(path);
    return true;
  } catch {
    return false;
  }
}

// Assemble the full config capture. Each source is independently fallible: a
// failed `claude` subprocess yields an unparsed category, never aborting the
// others (Constitution Principle VI). Pure given an injected IO + clock.
export function assembleClaudeConfig(opts: AssembleOptions = {}): ConfigCapture {
  const io = opts.io ?? defaultIO;
  const now = opts.now ?? (() => new Date().toISOString());

  const mcpRun = io.run("claude", ["mcp", "list"]);
  const mcpServers =
    mcpRun.status === 0 ? parseMcpList(mcpRun.stdout) : unparsedSource<CapturedMcpServer>();

  const pluginRun = io.run("claude", ["plugin", "list"]);
  const plugins =
    pluginRun.status === 0 ? parsePluginList(pluginRun.stdout) : unparsedSource<CapturedPlugin>();

  const hooks = mergeHookSources(gatherHookSources(io, plugins.items));
  const skillsAgents = enumerateSkillsAgents(io, enabledPluginRoots(io, plugins.items));

  return {
    schemaVersion: 1,
    sourceTool: SOURCE_TOOL,
    capturedAt: now(),
    hooks,
    mcpServers,
    plugins,
    skillsAgents,
  };
}

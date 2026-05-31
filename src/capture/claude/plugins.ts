import type { CapturedPlugin, PluginStatus, SourceResult } from "../types.js";

// Parse `claude plugin list` stdout (research Decision 2). Verified block shape:
//
//   Installed plugins:
//
//     ❯ base@amplitude-internal
//       Version: 1.3.2
//       Scope: managed
//       Status: ✔ enabled
//
// `Version: unknown` is preserved verbatim — never fabricated.

const HEAD = /^❯\s+(.+)$/u;
const KV = /^(Version|Scope|Status):\s*(.+)$/u;

interface PartialPlugin {
  name: string;
  version?: string;
  scope?: string;
  status?: PluginStatus;
}

export function parsePluginList(stdout: string): SourceResult<CapturedPlugin> {
  const items: CapturedPlugin[] = [];
  let parseStatus: SourceResult<CapturedPlugin>["parseStatus"] = "parsed";
  let current: PartialPlugin | null = null;

  const flush = (): void => {
    if (!current) return;
    items.push({
      name: current.name,
      version: current.version ?? "unknown",
      scope: current.scope ?? "unknown",
      status: current.status ?? "disabled",
    });
    current = null;
  };

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "" || line === "Installed plugins:") continue;

    const head = HEAD.exec(line);
    if (head?.[1]) {
      flush();
      current = { name: head[1].trim() };
      continue;
    }

    if (!current) continue; // a stray non-block line — ignore (banner-ish)

    const kv = KV.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2];
    if (key === undefined || value === undefined) continue;
    const v = value.trim();
    if (key === "Version") current.version = v;
    else if (key === "Scope") current.scope = v;
    else current.status = /enabled/i.test(v) ? "enabled" : "disabled";
  }
  flush();

  return { items, parseStatus };
}

import type { CapturedSkillAgent, SkillAgentKind, SourceResult } from "../types.js";
import type { CaptureIO } from "./io.js";

// Enumerate the installed skills / slash-commands / custom agents inventory
// (research Decision 4) — the "what exists" inventory, deliberately distinct
// from 025's "what is loaded into context". Content is NEVER read: only
// directory entry names + their source.

export interface SkillAgentRoot {
  // "user" or "plugin:<name>"
  source: string;
  // Absolute dir whose `skills/`, `commands/`, `agents/` subdirs are enumerated.
  dir: string;
}

// (subdir, kind, whether entries are dirs). Skills are directories (each holds a
// SKILL.md); commands and agents are `.md` files.
const SUBDIRS: { sub: string; kind: SkillAgentKind; stripMd: boolean }[] = [
  { sub: "skills", kind: "skill", stripMd: false },
  { sub: "commands", kind: "slash_command", stripMd: true },
  { sub: "agents", kind: "agent", stripMd: true },
];

function nameFromEntry(entry: string, stripMd: boolean): string | null {
  if (entry.startsWith(".")) return null;
  if (stripMd) {
    if (!entry.endsWith(".md")) return null;
    return entry.slice(0, -3);
  }
  return entry;
}

export function enumerateSkillsAgents(
  io: CaptureIO,
  roots: SkillAgentRoot[],
): SourceResult<CapturedSkillAgent> {
  const items: CapturedSkillAgent[] = [];
  for (const root of roots) {
    for (const { sub, kind, stripMd } of SUBDIRS) {
      const dir = io.join(root.dir, sub);
      if (!io.isDir(dir)) continue;
      for (const entry of io.readDir(dir)) {
        const name = nameFromEntry(entry, stripMd);
        if (name === null) continue;
        items.push({ name, kind, source: root.source });
      }
    }
  }
  // Enumeration over directory listings cannot "fail to parse" the way a text
  // command can; a missing dir is simply skipped above.
  return { items, parseStatus: "parsed" };
}

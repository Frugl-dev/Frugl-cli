import type { CapturedHook, SourceResult } from "../types.js";

// Reconstruct the effective hook inventory (research Decision 3). Claude exposes
// NO headless hook listing (`claude -p "/hooks"` → "isn't available in this
// environment"), so the merged set is derived from the settings layers plus each
// enabled plugin's hooks.json. This module is the PURE merge over already-read
// JSON; the filesystem gathering + enabled-version resolution lives in index.ts.

export interface HookConfigSource {
  // e.g. "user-settings", "user-settings-local", "project-settings",
  // "project-settings-local", "plugin:superpowers".
  source: string;
  // Parsed JSON: a settings object ({ hooks: {...} }) or a plugin hooks.json
  // (which may be the event-map directly). null when the file was unreadable.
  config: unknown;
}

// Used to recognize a plugin hooks.json that is the event-map itself rather than
// nested under a `hooks` key.
const EVENT_HINT = /ToolUse|Stop|Prompt|Session|Notification|PreCompact|SubagentStop/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Locate the event→entries map within a source's config. Returns null when the
// source legitimately has no hooks (a settings file without a `hooks` key) so
// the caller does not mistake "no hooks" for "unreadable".
function extractEventMap(config: unknown): Record<string, unknown> | null {
  const obj = asRecord(config);
  if (!obj) return null;
  const nested = asRecord(obj.hooks);
  if (nested) return nested;
  const keys = Object.keys(obj);
  if (keys.some((k) => EVENT_HINT.test(k))) return obj;
  return null;
}

export function mergeHookSources(sources: HookConfigSource[]): SourceResult<CapturedHook> {
  const items: CapturedHook[] = [];
  let parseStatus: SourceResult<CapturedHook>["parseStatus"] = "parsed";

  for (const { source, config } of sources) {
    // A null config means the file existed but could not be read/parsed — honest
    // flag. A readable file with no hooks yields an empty map and is fine.
    if (config === null) {
      parseStatus = "unparsed";
      continue;
    }
    const eventMap = extractEventMap(config);
    if (!eventMap) continue;

    for (const [event, entriesRaw] of Object.entries(eventMap)) {
      if (!Array.isArray(entriesRaw)) {
        parseStatus = "unparsed";
        continue;
      }
      for (const entry of entriesRaw) {
        const e = asRecord(entry);
        if (!e) {
          parseStatus = "unparsed";
          continue;
        }
        const matcher = typeof e.matcher === "string" ? e.matcher : null;
        const hookList = Array.isArray(e.hooks) ? e.hooks : [];
        for (const h of hookList) {
          const hh = asRecord(h);
          if (!hh) {
            parseStatus = "unparsed";
            continue;
          }
          const command = typeof hh.command === "string" ? hh.command : "";
          items.push({ event, matcher, command, source });
        }
      }
    }
  }

  return { items, parseStatus };
}

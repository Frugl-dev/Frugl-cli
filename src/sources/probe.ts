import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface ProbeOptions {
  homeDir?: string;
}

// Returns true if the path exists, false only when it is genuinely absent.
// Any other error (e.g. EACCES) is surfaced rather than swallowed (FR-019).
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function home(opts?: ProbeOptions): string {
  return opts?.homeDir ?? homedir();
}

export function probeClaude(opts?: ProbeOptions): Promise<boolean> {
  return pathExists(path.join(home(opts), ".claude", "projects"));
}

export function probeCodex(opts?: ProbeOptions): Promise<boolean> {
  return pathExists(path.join(home(opts), ".codex", "sessions"));
}

export function probeCursor(opts?: ProbeOptions): Promise<boolean> {
  return pathExists(
    path.join(
      home(opts),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
  );
}

export function probeGemini(opts?: ProbeOptions): Promise<boolean> {
  return pathExists(path.join(home(opts), ".gemini", "tmp"));
}

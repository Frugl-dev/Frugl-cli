import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveGitContext } from "./git-context.js";

// The floor of the fallback chain. Mirrors the cloud's historical
// `basename(cwd) || "unknown"` derivation so an unresolvable directory keys the
// same on both sides.
export const UNKNOWN_PROJECT = "unknown";

// Resolve a stable, portable project identity for a directory, independent of
// `--link-prs`. The key is the **repo segment only** (e.g. "frugl") — host and
// owner are dropped and never leave the machine (spec 051 / R1). Fallback chain:
//   1. git remote → repo name (lowercased)         resolveGitContext().repository.name
//   2. package.json `name`
//   3. basename(cwd)                                 (today's behavior)
//   4. "unknown"
// `cwd` is the session's recorded working directory for uploads, or
// `process.cwd()` for snapshots; an absent cwd goes straight to "unknown".
// NEVER throws: any failure degrades to the next rung (fail-closed, FR-008).
export async function resolveProjectIdentity(cwd: string | undefined): Promise<string> {
  if (cwd === undefined || cwd.length === 0) return UNKNOWN_PROJECT;

  // Rung 1 — git remote. `resolveGitContext` never throws and already strips
  // credentials/.git, handles scp + URL forms, and ascends a worktree to its
  // repo root, so a worktree and its parent checkout share one identity.
  try {
    const resolution = await resolveGitContext({ cwd });
    if (resolution.kind === "resolved") {
      const name = resolution.gitContext.repository.name.trim().toLowerCase();
      if (name.length > 0) return name;
    }
  } catch {
    // fall through to the next rung
  }

  // Rung 2 — package.json `name`.
  const pkgName = await readPackageName(cwd);
  if (pkgName !== null) return pkgName;

  // Rung 3 — directory basename (parity with the cloud's basename derivation).
  const base = path.basename(cwd);
  if (base.length > 0 && base !== "." && base !== path.sep) return base;

  // Rung 4 — nothing resolvable.
  return UNKNOWN_PROJECT;
}

async function readPackageName(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(cwd, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const name = (parsed as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  } catch {
    // missing/unreadable/unparseable package.json → next rung
  }
  return null;
}

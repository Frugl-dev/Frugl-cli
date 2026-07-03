import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ── Gemini transcript → working directory resolution ────────────────────────────
//
// Gemini transcripts live at ~/.gemini/tmp/<name>/chats/*.jsonl, where <name> is
// a project label, NOT a path encoding. The mapping lives in ~/.gemini/
// projects.json: `{ "projects": { "<absolute-cwd>": "<name>", … } }` — so the
// cwd is recovered by REVERSING that registry. Two hazards, both fail-closed:
//
//   1. <name> is basename-ish, so two cwds can map to the same label. The
//      session header's `projectHash` is sha256(cwd) (verified on-machine
//      2026-07-02), so candidates are disambiguated by hashing each cwd and
//      matching the header. No hash match → no cwd (never a wrong one).
//   2. Without a header hash, only an UNAMBIGUOUS single candidate is trusted.
//
// The registry is read from the `.gemini` root derived from the transcript's own
// path (not from homedir), so temp-home tests work unchanged. This is the one
// descriptor extractor that touches the filesystem — the read is tiny, cached
// per registry path, and failure degrades to `undefined` (no git context),
// matching the resolver's fail-closed philosophy (git-context.ts).

const TRANSCRIPT_PATH = /^(.*\/\.gemini)\/tmp\/([^/]+)\/chats\//;

// registry path → cwd-by-name reverse map (null = unreadable/absent registry).
const registryCache = new Map<string, Map<string, string[]> | null>();

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function loadReverseRegistry(registryPath: string): Map<string, string[]> | null {
  const cached = registryCache.get(registryPath);
  if (cached !== undefined) return cached;
  let reverse: Map<string, string[]> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    const projects =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).projects
        : undefined;
    if (projects && typeof projects === "object" && !Array.isArray(projects)) {
      reverse = new Map();
      for (const [cwd, name] of Object.entries(projects as Record<string, unknown>)) {
        if (typeof name !== "string" || name.length === 0 || cwd.length === 0) continue;
        const list = reverse.get(name);
        if (list) list.push(cwd);
        else reverse.set(name, [cwd]);
      }
    }
  } catch {
    reverse = null;
  }
  registryCache.set(registryPath, reverse);
  return reverse;
}

// Test seam: registries are cached per path for the life of the process; tests
// that rewrite a registry in place can reset between cases.
export function clearGeminiRegistryCache(): void {
  registryCache.clear();
}

// The working directory a Gemini transcript was recorded in, or undefined when
// it cannot be established SAFELY (unknown label, ambiguous without a hash,
// hash mismatch, unreadable registry). See module comment for the contract.
export function resolveGeminiCwd(
  transcriptPath: string,
  projectHash: string | undefined,
): string | undefined {
  const match = TRANSCRIPT_PATH.exec(transcriptPath.replace(/\\/g, "/"));
  if (!match) return undefined;
  const geminiRoot = match[1]!;
  const dirName = match[2]!;

  const reverse = loadReverseRegistry(`${geminiRoot}/projects.json`);
  const candidates = reverse?.get(dirName);
  if (!candidates || candidates.length === 0) return undefined;

  if (projectHash) {
    // Disambiguate (and verify) via the header hash — sha256(cwd).
    const byHash = candidates.find((cwd) => sha256(cwd) === projectHash);
    return byHash; // undefined when nothing matches: fail closed.
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

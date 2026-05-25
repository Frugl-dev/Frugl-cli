import path from "node:path";
import type { SessionRef, Source } from "./types.js";
import { claudeCodeSource } from "./claude-code/index.js";
import { deriveClaudeProjects } from "./claude-code/project.js";
import { cursorSource } from "./cursor/index.js";
import { codexSource } from "./codex/index.js";
import { geminiSource } from "./gemini/index.js";
import { probeClaude, probeCodex, probeCursor, probeGemini, type ProbeOptions } from "./probe.js";

export type ProviderId = "claude" | "codex" | "cursor" | "gemini";

export interface ProjectGroup {
  providerId: ProviderId;
  projectId: string;
  displayName: string;
  sessions: SessionRef[];
  sessionCount: number;
}

export interface ProviderDescriptor {
  id: ProviderId;
  displayName: string;
  supported: boolean;
  probe(opts?: ProbeOptions): Promise<boolean>;
  // Present iff `supported`:
  source?: Source;
  deriveProjects?(refs: SessionRef[]): ProjectGroup[];
}

function deriveCursorProjects(refs: SessionRef[]): ProjectGroup[] {
  const byProject = new Map<string, SessionRef[]>();
  for (const ref of refs) {
    const parts = ref.absolutePath.replace(/\\/g, "/").split("/");
    const projIdx = parts.indexOf("projects");
    const projectId =
      projIdx >= 0 && parts[projIdx + 1]
        ? parts[projIdx + 1]!
        : path.basename(path.dirname(path.dirname(ref.absolutePath)));
    const sessions = byProject.get(projectId);
    if (sessions) sessions.push(ref);
    else byProject.set(projectId, [ref]);
  }
  return [...byProject.entries()].map(([projectId, sessions]) => ({
    providerId: "cursor" as ProviderId,
    projectId,
    displayName: projectId,
    sessions,
    sessionCount: sessions.length,
  }));
}

function deriveFlatProjects(providerId: ProviderId, displayName: string) {
  return (refs: SessionRef[]): ProjectGroup[] =>
    refs.length === 0
      ? []
      : [
          {
            providerId,
            projectId: providerId,
            displayName,
            sessions: refs,
            sessionCount: refs.length,
          },
        ];
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    supported: true,
    probe: probeClaude,
    source: claudeCodeSource,
    deriveProjects: deriveClaudeProjects,
  },
  {
    id: "codex",
    displayName: "Codex",
    supported: true,
    probe: probeCodex,
    source: codexSource,
    deriveProjects: deriveFlatProjects("codex", "Codex sessions"),
  },
  {
    id: "cursor",
    displayName: "Cursor",
    supported: true,
    probe: probeCursor,
    source: cursorSource,
    deriveProjects: deriveCursorProjects,
  },
  {
    id: "gemini",
    displayName: "Gemini",
    supported: true,
    probe: probeGemini,
    source: geminiSource,
    deriveProjects: deriveFlatProjects("gemini", "Gemini sessions"),
  },
];

export interface DetectedProvider {
  descriptor: ProviderDescriptor;
}

export function getProvider(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// Probes every provider concurrently and returns only those present, preserving
// registry order. A non-ENOENT probe failure propagates (honest failure, FR-019).
export async function detectProviders(opts?: ProbeOptions): Promise<DetectedProvider[]> {
  const probed = await Promise.all(
    PROVIDERS.map(async (descriptor) => ({ descriptor, detected: await descriptor.probe(opts) })),
  );
  return probed.filter((p) => p.detected).map((p) => ({ descriptor: p.descriptor }));
}

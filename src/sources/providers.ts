import type { SessionRef, Source } from "./types.js";
import { claudeCodeSource } from "./claude-code/index.js";
import { deriveClaudeProjects } from "./claude-code/project.js";
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

// Registry order is the display order. Claude Code is the only provider the CLI
// can parse/upload in v1; the rest are detection-only (probe only, no parser).
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    supported: true,
    probe: probeClaude,
    source: claudeCodeSource,
    deriveProjects: deriveClaudeProjects,
  },
  { id: "codex", displayName: "Codex", supported: false, probe: probeCodex },
  { id: "cursor", displayName: "Cursor", supported: false, probe: probeCursor },
  { id: "gemini", displayName: "Gemini", supported: false, probe: probeGemini },
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

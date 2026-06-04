import type { SessionRef, Source } from "./types.js";
import { DESCRIPTORS } from "./descriptor.js";
import { probe, toSource } from "./walker.js";

export type ProviderId = "claude" | "codex" | "cursor" | "gemini";

export interface ProjectGroup {
  providerId: ProviderId;
  projectId: string;
  displayName: string;
  sessions: SessionRef[];
  sessionCount: number;
}

export interface ProbeOptions {
  homeDir?: string;
}

// A registry entry: the runtime view of a provider that downstream code consumes
// (probe + Source + project derivation). Derived from the pure-data
// ProviderDescriptor via `toSource`; never hand-maintained alongside it.
export interface RegisteredProvider {
  id: ProviderId;
  displayName: string;
  supported: boolean;
  probe(opts?: ProbeOptions): Promise<boolean>;
  // Present iff `supported`:
  source?: Source;
  deriveProjects?(refs: SessionRef[]): ProjectGroup[];
}

// The registry is derived from the descriptors so a provider can never appear in
// PROVIDERS without its Source (and vice versa). Order matches DESCRIPTORS.
export const PROVIDERS: readonly RegisteredProvider[] = DESCRIPTORS.map((d) => ({
  id: d.id,
  displayName: d.displayName,
  supported: true,
  probe: (opts?: ProbeOptions) => probe(d, opts),
  source: toSource(d),
  deriveProjects: d.deriveProjects,
}));

export interface DetectedProvider {
  descriptor: RegisteredProvider;
}

export function getProvider(id: string): RegisteredProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// The parser registry is *derived* from PROVIDERS rather than maintained as a
// second hand-written list, so a provider can never appear in one without the
// other. `getSourceByKind` maps a discovered SessionRef back to the Source that
// knows how to parse it.
export const SOURCES: readonly Source[] = PROVIDERS.flatMap((p) => (p.source ? [p.source] : []));

export function getSourceByKind(kind: string): Source | undefined {
  return SOURCES.find((s) => s.kind === kind);
}

// Probes every provider concurrently and returns only those present, preserving
// registry order. A non-ENOENT probe failure propagates (honest failure, FR-019).
export async function detectProviders(opts?: ProbeOptions): Promise<DetectedProvider[]> {
  const probed = await Promise.all(
    PROVIDERS.map(async (descriptor) => ({ descriptor, detected: await descriptor.probe(opts) })),
  );
  return probed.filter((p) => p.detected).map((p) => ({ descriptor: p.descriptor }));
}

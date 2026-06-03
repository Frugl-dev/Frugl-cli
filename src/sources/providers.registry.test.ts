import { describe, it, expect } from "vitest";
import { PROVIDERS, SOURCES, getProvider, getSourceByKind } from "./providers.js";

// These assert the registry invariants that previously relied on a second,
// hand-maintained SOURCES list staying in sync with PROVIDERS. With SOURCES now
// derived from PROVIDERS, a provider can never be parseable-but-unroutable (or
// vice versa); this is the boundary that fails loudly if that ever regresses.
describe("provider registry", () => {
  it("derives one Source per supported provider", () => {
    const supported = PROVIDERS.filter((p) => p.supported);
    expect(SOURCES).toHaveLength(supported.length);
  });

  it("routes every supported provider's source kind back to its Source", () => {
    for (const provider of PROVIDERS) {
      if (!provider.supported) continue;
      expect(provider.source).toBeDefined();
      const resolved = getSourceByKind(provider.source!.kind);
      expect(resolved).toBe(provider.source);
    }
  });

  it("gives every supported provider a project-derivation function", () => {
    for (const provider of PROVIDERS) {
      if (!provider.supported) continue;
      expect(typeof provider.deriveProjects).toBe("function");
    }
  });

  it("uses unique provider ids and source kinds", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = SOURCES.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("returns undefined for unknown ids and kinds", () => {
    expect(getProvider("nope")).toBeUndefined();
    expect(getSourceByKind("nope")).toBeUndefined();
  });
});

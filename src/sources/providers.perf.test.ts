import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectProviders, getProvider } from "./providers.js";
import { writeTestSessions } from "../e2e/helpers/fixtures.js";

// SC-005: detection + project discovery should reach the first prompt quickly
// even on a busy machine.
describe("detection + discovery performance (SC-005)", { timeout: 30_000 }, () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "frugl-perf-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("detects + groups 200 projects in well under 3 seconds", async () => {
    for (let i = 0; i < 200; i++) {
      await writeTestSessions(home, 1, `-Users-me-proj${i}`);
    }

    const started = Date.now();
    const detected = await detectProviders({ homeDir: home });
    const claude = getProvider("claude")!;
    const refs = await claude.source!.discover({ homeDir: home });
    const groups = claude.deriveProjects!(refs);
    const elapsed = Date.now() - started;

    expect(detected.map((d) => d.descriptor.id)).toContain("claude");
    expect(groups).toHaveLength(200);
    expect(elapsed).toBeLessThan(3000);
  });
});

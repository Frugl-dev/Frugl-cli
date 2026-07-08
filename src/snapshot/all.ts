import { CloudHttpError } from "../cloud/client.js";
import { isFruglError, printFruglError } from "../lib/errors.js";
import { color } from "../lib/theme.js";
import { reportContext, runContextSnapshot } from "../context/run.js";
import { reportMcp, runMcpSnapshot } from "../mcp-snapshot/run.js";
import type { SnapshotRunContext } from "./shared.js";

// One snapshot to run as part of `frugl snapshot`: capture + upload + print. It
// throws (fail-closed) on failure; runAllSnapshots decides how to surface it.
export type SnapshotStep = (ctx: SnapshotRunContext) => Promise<void>;

export const contextStep: SnapshotStep = async (ctx) =>
  reportContext(await runContextSnapshot(ctx), ctx.mode);

export const mcpStep: SnapshotStep = async (ctx) => {
  // `frugl snapshot` runs two independent snapshots back-to-back; the MCP pass
  // reuses the same "Checking MCP servers…"/"Uploading snapshot…" step lines as
  // the context pass, so without a header the second block reads as a stray
  // repeat. Announce it as its own section (default mode only, matching stepLog).
  if (ctx.mode === "default") process.stderr.write(color.dim("\n  MCP snapshot\n"));
  reportMcp(await runMcpSnapshot(ctx), ctx.mode);
};

// Run every snapshot step (context then mcp) against one run context. Each step
// is independent: a failure in one is reported and never blocks the rest (the
// per-run fail-closed guarantee, applied across the pair). Returns the process
// exit code — 0 when all succeeded, otherwise the FIRST failure's code so the
// caller can exit non-zero. Expected failures (FruglError / CloudHttpError) are
// printed via the shared error formatter; an unexpected error propagates to
// oclif rather than being swallowed. Steps are injectable for testing.
export async function runAllSnapshots(
  ctx: SnapshotRunContext,
  steps: SnapshotStep[] = [contextStep, mcpStep],
): Promise<number> {
  let exitCode = 0;
  for (const step of steps) {
    try {
      await step(ctx);
    } catch (err) {
      if (isFruglError(err) || err instanceof CloudHttpError) {
        const code = printFruglError(err, ctx.mode);
        if (exitCode === 0) exitCode = code;
        continue;
      }
      throw err;
    }
  }
  return exitCode;
}

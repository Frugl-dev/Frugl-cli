import type { OutputMode } from "./output-mode.js";
import { color } from "./theme.js";

// A sequence of discrete, unmeasurable steps (subprocess spawns, network
// round-trips) with no natural progress bar — each can silently take seconds
// and prints nothing on its own, which reads as a hang (see snapshot's
// capture/upload/handoff chain). One dim status line per step keeps the run
// legible. Silent outside default mode, mirroring liveLocalProgress's
// contract: minimal/json stay terse for agents/CI.
export function stepLog(mode: OutputMode, label: string): void {
  if (mode !== "default") return;
  process.stderr.write(color.dim(`  ${label}\n`));
}

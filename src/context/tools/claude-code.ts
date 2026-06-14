import { spawnSync } from "node:child_process";
import { FruglError } from "../../lib/errors.js";
import { EXIT } from "../../lib/exit-codes.js";

// Injectable spawn boundary so the runner is unit-testable without spawning the
// real `claude` binary. Mirrors the shape of node:child_process spawnSync's
// result that this runner reads.
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  // Present when the binary could not be spawned at all (ENOENT etc.).
  error?: Error | undefined;
}

export type Spawner = (cmd: string, args: string[]) => SpawnResult;

const defaultSpawner: Spawner = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    status: res.status,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
    error: res.error,
  };
};

// Capture Claude Code's context breakdown by running `claude -p "/context"` and
// returning its stdout verbatim. Honest-failure boundary: a missing binary, a
// non-zero exit, or empty stdout each throw a FruglError with an instructive
// message rather than returning partial/fabricated data. The caller never sees
// a successful result that didn't come straight from the tool's stdout.
export function captureClaudeCodeContext(spawner: Spawner = defaultSpawner): string {
  const result = spawner("claude", ["-p", "/context"]);

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new FruglError(
        "The 'claude' CLI was not found on your PATH. Install Claude Code (https://docs.claude.com/claude-code) and ensure `claude` is runnable, then re-run `frugl snapshot context`.",
        EXIT.GENERIC_FAILURE,
      );
    }
    throw new FruglError(
      `Failed to launch 'claude': ${result.error.message}`,
      EXIT.GENERIC_FAILURE,
    );
  }

  if (result.status !== 0) {
    const snippet = result.stderr.trim().slice(0, 500);
    throw new FruglError(
      `'claude -p "/context"' exited with code ${result.status ?? "unknown"}.${
        snippet ? ` stderr: ${snippet}` : ""
      }`,
      EXIT.GENERIC_FAILURE,
    );
  }

  if (result.stdout.trim().length === 0) {
    throw new FruglError(
      "'claude -p \"/context\"' produced no output. Cannot capture a context snapshot from empty output.",
      EXIT.GENERIC_FAILURE,
    );
  }

  return result.stdout;
}

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(moduleDir, "../../../bin/dev.js");
const TSX = resolve(moduleDir, "../../../node_modules/.bin/tsx");

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  // Working directory for the spawned CLI. Commands that read/write project-local
  // files (e.g. `init` writing `.frugl.json`) need this pointed at a temp dir so
  // the test never touches the repo's own cwd. Defaults to a shared, isolated
  // scratch directory (see defaultCwd below) rather than inheriting the real
  // repo cwd: a `.frugl.json` sitting at the repo root (e.g. from a contributor
  // running `frugl init` there for real) would otherwise silently scope
  // config-driven commands to it for every test that forgot to pass `cwd`.
  cwd?: string;
}

// Lazily created once per test process — every runCli() call that doesn't pass
// its own `cwd` shares this directory. It's never written to by the commands
// these tests spawn (only `init` writes cwd-relative files, and init tests
// always pass an explicit `cwd`), so sharing it across calls is safe.
let defaultCwd: string | undefined;
function getDefaultCwd(): string {
  defaultCwd ??= mkdtempSync(join(tmpdir(), "frugl-e2e-cwd-"));
  return defaultCwd;
}

export async function runCli(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) {
    if (v !== undefined) env[k] = v;
  }

  const child = spawn(TSX, [BIN, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd ?? getDefaultCwd(),
  });

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const timeoutMs = opts.timeoutMs ?? 20_000;
  const exitCode = await new Promise<number>((done, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `CLI timed out after ${timeoutMs}ms\nargs: ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timeout);
      done(code ?? 1);
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return { exitCode, stdout, stderr };
}

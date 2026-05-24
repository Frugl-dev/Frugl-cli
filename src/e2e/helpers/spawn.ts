import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../../../bin/dev.js");
const TSX = resolve(__dirname, "../../../node_modules/.bin/tsx");

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export async function runCli(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) {
    if (v !== undefined) env[k] = v;
  }

  const child = spawn(TSX, [BIN, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
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
  const exitCode = await new Promise<number>((resolve, reject) => {
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
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return { exitCode, stdout, stderr };
}

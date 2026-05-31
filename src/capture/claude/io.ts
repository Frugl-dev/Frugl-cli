import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Injectable IO boundary so the capture assembly (index.ts) and the skills/agents
// enumeration are unit-testable without touching the real filesystem or spawning
// `claude`. The default implementation wraps the Node stdlib.

export interface CommandResult {
  stdout: string;
  status: number;
}

export interface CaptureIO {
  run(cmd: string, args: string[]): CommandResult;
  readFile(path: string): string; // throws if missing
  readDir(path: string): string[]; // entry names; [] if missing
  isDir(path: string): boolean;
  homedir(): string;
  cwd(): string;
  join(...parts: string[]): string;
}

export const defaultIO: CaptureIO = {
  run(cmd, args) {
    try {
      const stdout = execFileSync(cmd, args, { encoding: "utf8" });
      return { stdout, status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: typeof e.stdout === "string" ? e.stdout : "", status: e.status ?? 1 };
    }
  },
  readFile: (path) => readFileSync(path, "utf8"),
  readDir(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  isDir(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  homedir,
  cwd: () => process.cwd(),
  join,
};

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

export interface TempDir {
  dir: string;
  cleanup: () => Promise<void>;
}

export interface TestSession {
  sessionId: string;
  filePath: string;
}

export async function makeTempDir(): Promise<TempDir> {
  const dir = path.join(tmpdir(), `poppi-e2e-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Writes N fake Claude Code JSONL session files under
 * <homeDir>/.claude/projects/<projName>/ and returns their identities.
 */
export async function writeTestSessions(
  homeDir: string,
  count: number,
  projName = "test-project",
): Promise<TestSession[]> {
  const projectDir = path.join(homeDir, ".claude", "projects", projName);
  await mkdir(projectDir, { recursive: true });

  const sessions: TestSession[] = [];
  for (let i = 0; i < count; i++) {
    const sessionId = randomUUID();
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    const records = [
      {
        sessionId,
        type: "user",
        message: `Hello from session ${i}`,
        timestamp: new Date().toISOString(),
      },
      {
        sessionId,
        type: "assistant",
        message: `Response ${i}`,
        timestamp: new Date().toISOString(),
      },
    ];
    await writeFile(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    sessions.push({ sessionId, filePath });
  }
  return sessions;
}

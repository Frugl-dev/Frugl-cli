import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { nowIso } from "../../lib/time.js";

export interface TempDir {
  dir: string;
  cleanup: () => Promise<void>;
}

export interface TestSession {
  sessionId: string;
  filePath: string;
}

export async function makeTempDir(): Promise<TempDir> {
  const dir = path.join(tmpdir(), `frugl-e2e-${randomUUID()}`);
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

  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const sessionId = randomUUID();
      const filePath = path.join(projectDir, `${sessionId}.jsonl`);
      const records = [
        {
          sessionId,
          type: "human",
          message: {
            role: "user",
            content: [{ type: "text", text: `Hello from session ${i}` }],
          },
          timestamp: nowIso(),
        },
        {
          sessionId,
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: `Response ${i}` }],
            // Sized so each fixture session clears the default $10.00 --min-cost
            // floor (~$18 at Sonnet pricing: 1M input @ $3/MTok + 1M output @
            // $15/MTok); otherwise the default cost filter would drop every test
            // session.
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 1_000_000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          timestamp: nowIso(),
        },
      ];
      await writeFile(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      return { sessionId, filePath };
    }),
  );
}

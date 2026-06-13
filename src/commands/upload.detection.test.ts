import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXIT } from "../lib/exit-codes.js";
import { MockServer } from "../e2e/helpers/mock-server.js";
import { runCli } from "../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../e2e/helpers/auth.js";
import { makeTempDir, writeTestSessions, type TempDir } from "../e2e/helpers/fixtures.js";

interface ManifestSession {
  session_id: string;
}

interface SelectionReport {
  providers: Array<{ id: string; supported: boolean; selected: boolean }>;
  projects: Array<{ projectId: string; selected: boolean; sessionCount: number }>;
}

async function makeCursorFixture(homeDir: string): Promise<void> {
  const dir = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
  );
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "state.vscdb"), "");
}

function lastJson(stdout: string): { selection: SelectionReport; ok: boolean } {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as { command?: string };
      if (parsed.command === "upload") return parsed as never;
    } catch {
      // not JSON — keep scanning
    }
  }
  throw new Error(`no upload result JSON in stdout:\n${stdout}`);
}

describe("frugl upload — provider detection & guided selection", { timeout: 30_000 }, () => {
  let server: MockServer;
  let home: TempDir;
  let manifestSessions: ManifestSession[];

  beforeEach(async () => {
    manifestSessions = [];
    server = await new MockServer().start();
    server.on(
      "POST",
      "/api/uploads/manifest",
      (_req: IncomingMessage, res: ServerResponse, _p, body: Buffer) => {
        manifestSessions = (JSON.parse(body.toString()) as { sessions: ManifestSession[] })
          .sessions;
        server.json(res, 200, { upload_id: "mfst-1" });
      },
    );
    MockServer.wireHappyPath(server);
    home = await makeTempDir();
    injectAuth(makeTestSession(server.url));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await home.cleanup();
    await server.close();
  });

  it("exits NO_SESSIONS_FOUND when no provider is detected", async () => {
    const { exitCode } = await runCli(["upload", "--yes", "--endpoint", server.url], {
      env: { FRUGL_HOME_DIR: home.dir },
    });
    expect(exitCode).toBe(EXIT.NO_SESSIONS_FOUND);
    expect(manifestSessions.length).toBe(0);
  });

  it("exits OK with nothing uploaded when a detected provider has no session files", async () => {
    await makeCursorFixture(home.dir);
    const { exitCode } = await runCli(["upload", "--yes", "--endpoint", server.url], {
      env: { FRUGL_HOME_DIR: home.dir },
    });
    expect(exitCode).toBe(EXIT.OK);
    expect(manifestSessions.length).toBe(0);
  });

  it("non-interactive: uploads every Claude session across all projects, zero prompts", async () => {
    await writeTestSessions(home.dir, 2, "-Users-me-app");
    await writeTestSessions(home.dir, 1, "-Users-me-scratch");

    const { exitCode, stdout } = await runCli(
      ["upload", "sessions", "--yes", "--format", "json", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    expect(manifestSessions.length).toBe(3);

    const { selection } = lastJson(stdout);
    expect(selection.providers).toEqual([
      expect.objectContaining({ id: "claude", supported: true, selected: true }),
    ]);
    expect(selection.projects.map((p) => p.projectId).toSorted()).toEqual([
      "-Users-me-app",
      "-Users-me-scratch",
    ]);
    expect(selection.projects.every((p) => p.selected)).toBe(true);
  });

  it("detected provider with no sessions does not contribute to upload (SC-002)", async () => {
    await writeTestSessions(home.dir, 2, "-Users-me-app");
    await makeCursorFixture(home.dir);

    const { exitCode, stdout } = await runCli(
      ["upload", "sessions", "--yes", "--format", "json", "--endpoint", server.url],
      { env: { FRUGL_HOME_DIR: home.dir } },
    );
    expect(exitCode).toBe(EXIT.OK);
    // Only the two Claude sessions are uploaded; Cursor has no session files.
    expect(manifestSessions.length).toBe(2);

    const { selection } = lastJson(stdout);
    const cursor = selection.providers.find((p) => p.id === "cursor")!;
    expect(cursor.supported).toBe(true);
    expect(cursor.selected).toBe(true);
    const claude = selection.providers.find((p) => p.id === "claude")!;
    expect(claude.selected).toBe(true);
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { SnapshotRunContext } from "../snapshot/shared.js";
import type { SnapshotUploadResult } from "../upload/snapshot.js";
import type { HandoffResult } from "../cloud/handoff.js";

// --- Mocks for the runMcpSnapshot pipeline (collaborators have their own
// suites; here we drive run.ts orchestration + gate branches). ---
const captureMcpInventory = vi.fn<
  () => {
    capturedAt: string;
    parseStatus: "parsed" | "unparsed";
    mcpServers: unknown[];
  }
>();
vi.mock("./capture.js", () => ({
  captureMcpInventory: () => captureMcpInventory(),
  MCP_SOURCE_TOOL: "claude-code",
}));

const buildMcpPayload = vi.fn<() => unknown>();
vi.mock("./payload.js", () => ({ buildMcpPayload: () => buildMcpPayload() }));

const uploadMcpSnapshot = vi.fn<() => Promise<SnapshotUploadResult>>();
vi.mock("./upload.js", () => ({ uploadMcpSnapshot: () => uploadMcpSnapshot() }));

const requestHandoffUrl = vi.fn<() => Promise<HandoffResult>>();
vi.mock("../cloud/handoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cloud/handoff.js")>();
  return { ...actual, requestHandoffUrl: () => requestHandoffUrl() };
});

vi.mock("../upload/cloud-http-adapter.js", () => ({
  // oxlint-disable-next-line typescript/no-extraneous-class -- stand-in class mock matching HttpCloudAdapter's constructor shape
  HttpCloudAdapter: class {
    // oxlint-disable-next-line no-useless-constructor -- signature must match the real HttpCloudAdapter constructor
    constructor(_client: unknown) {}
  },
}));

const { reportMcp, runMcpSnapshot } = await import("./run.js");
type McpReport = Awaited<ReturnType<typeof runMcpSnapshot>>;

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStdout(fn: () => void): string {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  fn();
  return out;
}

const uploaded: McpReport = {
  status: "uploaded",
  capturedAt: "2026-06-06T09:00:00.000Z",
  serverCount: 2,
  parseStatus: "parsed",
  manifestId: "mfst_1",
  sessionId: "sess_1",
  policyVersion: "v0.1",
  byteSize: 99,
  handoff: { active: false, dashboardUrl: "https://app/dash", reason: "disabled-default" },
};

describe("reportMcp", () => {
  it("emits a machine-readable JSON object on an uploaded snapshot (--format json)", () => {
    const out = captureStdout(() => reportMcp(uploaded, "json"));
    expect(JSON.parse(out)).toMatchObject({
      command: "mcp",
      ok: true,
      status: "uploaded",
      tool: "claude-code",
      capturedAt: "2026-06-06T09:00:00.000Z",
      serverCount: 2,
      parseStatus: "parsed",
      manifestId: "mfst_1",
      sessionId: "sess_1",
      redactionPolicyVersion: "v0.1",
      byteSize: 99,
      dashboardUrl: "https://app/dash",
    });
  });

  it("reports no_change as ok with nothing uploaded (json)", () => {
    const out = captureStdout(() => reportMcp({ status: "no_change" }, "json"));
    expect(JSON.parse(out)).toEqual({
      command: "mcp",
      ok: true,
      status: "no_change",
      tool: "claude-code",
    });
  });

  it("prints a human line with the server count and dashboard URL (default)", () => {
    const out = captureStdout(() => reportMcp(uploaded, "default"));
    expect(out).toContain("MCP snapshot captured");
    expect(out).toContain("2 servers");
    expect(out).toContain("https://app/dash");
  });

  it("pluralizes a single server correctly (default)", () => {
    const out = captureStdout(() => reportMcp({ ...uploaded, serverCount: 1 }, "default"));
    expect(out).toContain("1 server)");
  });

  it("prints the no_change line in default mode", () => {
    const out = captureStdout(() => reportMcp({ status: "no_change" }, "default"));
    expect(out).toContain("No change since your last MCP snapshot");
  });

  it("reports cap_reached in json mode", () => {
    const out = captureStdout(() =>
      reportMcp(
        { status: "cap_reached", cap: 5, used: 5, windowResetsAt: "2026-07-01T00:00:00.000Z" },
        "json",
      ),
    );
    expect(JSON.parse(out)).toMatchObject({
      command: "mcp",
      status: "cap_reached",
      cap: 5,
      used: 5,
      windowResetsAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("prints the cap_reached lines (used/cap + reset) in default mode", () => {
    const out = captureStdout(() =>
      reportMcp(
        { status: "cap_reached", cap: 5, used: 5, windowResetsAt: "2026-07-01T00:00:00.000Z" },
        "default",
      ),
    );
    expect(out).toContain("Weekly snapshot limit reached (5/5)");
    expect(out).toContain("Resets 2026-07-01T00:00:00.000Z");
  });

  it("prints the auto sign-in line when the handoff is active (default)", () => {
    const active: McpReport = {
      ...uploaded,
      handoff: {
        active: true,
        dashboardUrl: "https://app/dash",
        expiresAt: "2026-06-06T09:01:00.000Z",
      },
    };
    const out = captureStdout(() => reportMcp(active, "default"));
    expect(out).toContain("auto sign-in link");
  });

  it("prints the unavailable line when handoff failed for a non-disabled reason (default)", () => {
    const failed: McpReport = {
      ...uploaded,
      handoff: { active: false, dashboardUrl: "https://app/dash", reason: "unavailable" },
    };
    const out = captureStdout(() => reportMcp(failed, "default"));
    expect(out).toContain("sign-in link unavailable");
  });
});

describe("runMcpSnapshot", () => {
  const ctx: SnapshotRunContext = {
    client: { cliVersion: "9.9.9" } as unknown as SnapshotRunContext["client"],
    session: { email: "a@b.test" } as unknown as SnapshotRunContext["session"],
    mode: "default",
  };

  beforeEach(() => {
    captureMcpInventory.mockReset();
    buildMcpPayload.mockReset();
    uploadMcpSnapshot.mockReset();
    requestHandoffUrl.mockReset();

    captureMcpInventory.mockReturnValue({
      capturedAt: "2026-06-06T09:00:00.000Z",
      parseStatus: "parsed",
      mcpServers: [{}, {}],
    });
    buildMcpPayload.mockReturnValue({
      body: Buffer.from("[]"),
      byteSize: 2,
      contentHash: "hash",
      redactionSummary: {},
      policyVersion: "v0.1",
    });
    requestHandoffUrl.mockResolvedValue({
      active: false,
      dashboardUrl: "https://app/dash",
      reason: "disabled-default",
    });
  });

  it("returns an uploaded report with the server count + parse status", async () => {
    uploadMcpSnapshot.mockResolvedValue({
      status: "uploaded",
      manifestId: "mfst_1",
      sessionId: "sess_1",
      dashboardUrl: "https://app/dash",
    });
    const report = await runMcpSnapshot(ctx);
    expect(report).toMatchObject({
      status: "uploaded",
      capturedAt: "2026-06-06T09:00:00.000Z",
      serverCount: 2,
      parseStatus: "parsed",
      manifestId: "mfst_1",
      sessionId: "sess_1",
      policyVersion: "v0.1",
      byteSize: 2,
    });
    expect(requestHandoffUrl).toHaveBeenCalledOnce();
  });

  it("returns no_change without requesting a handoff", async () => {
    uploadMcpSnapshot.mockResolvedValue({ status: "no_change" });
    const report = await runMcpSnapshot(ctx);
    expect(report).toEqual({ status: "no_change" });
    expect(requestHandoffUrl).not.toHaveBeenCalled();
  });

  it("returns cap_reached with the window fields, no handoff", async () => {
    uploadMcpSnapshot.mockResolvedValue({
      status: "cap_reached",
      cap: 5,
      used: 5,
      windowResetsAt: "2026-07-01T00:00:00.000Z",
    });
    const report = await runMcpSnapshot(ctx);
    expect(report).toEqual({
      status: "cap_reached",
      cap: 5,
      used: 5,
      windowResetsAt: "2026-07-01T00:00:00.000Z",
    });
    expect(requestHandoffUrl).not.toHaveBeenCalled();
  });
});

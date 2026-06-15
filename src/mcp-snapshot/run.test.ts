import { describe, it, expect, vi, afterEach } from "vitest";
import { reportMcp, type McpReport } from "./run.js";

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
});

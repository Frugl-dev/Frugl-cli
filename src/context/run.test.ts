import { describe, it, expect, vi, afterEach } from "vitest";
import { reportContext, type ContextReport } from "./run.js";

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

const uploaded: ContextReport = {
  status: "uploaded",
  capturedAt: "2026-06-06T09:00:00.000Z",
  manifestId: "mfst_1",
  sessionId: "sess_1",
  policyVersion: "v0.1",
  byteSize: 42,
  handoff: { active: false, dashboardUrl: "https://app/dash", reason: "disabled-default" },
};

describe("reportContext", () => {
  it("emits a single machine-readable JSON object on an uploaded snapshot (--format json)", () => {
    const out = captureStdout(() => reportContext(uploaded, "json"));
    const obj = JSON.parse(out);
    expect(obj).toMatchObject({
      command: "context",
      ok: true,
      status: "uploaded",
      tool: "claude-code",
      capturedAt: "2026-06-06T09:00:00.000Z",
      manifestId: "mfst_1",
      sessionId: "sess_1",
      redactionPolicyVersion: "v0.1",
      byteSize: 42,
      dashboardUrl: "https://app/dash",
    });
  });

  it("reports no_change as ok with nothing uploaded (json)", () => {
    const out = captureStdout(() => reportContext({ status: "no_change" }, "json"));
    expect(JSON.parse(out)).toEqual({
      command: "context",
      ok: true,
      status: "no_change",
      tool: "claude-code",
    });
  });

  it("reports cap_reached with the window fields (json)", () => {
    const out = captureStdout(() =>
      reportContext(
        { status: "cap_reached", cap: 7, used: 7, windowResetsAt: "2026-06-21T00:00:00.000Z" },
        "json",
      ),
    );
    expect(JSON.parse(out)).toMatchObject({
      command: "context",
      status: "cap_reached",
      cap: 7,
      used: 7,
      windowResetsAt: "2026-06-21T00:00:00.000Z",
    });
  });

  it("prints a human line with the dashboard URL on an uploaded snapshot (default)", () => {
    const out = captureStdout(() => reportContext(uploaded, "default"));
    expect(out).toContain("Context snapshot captured");
    expect(out).toContain("https://app/dash");
  });
});

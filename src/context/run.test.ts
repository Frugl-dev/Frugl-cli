import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { SnapshotRunContext } from "../snapshot/shared.js";
import type { SnapshotUploadResult } from "../upload/snapshot.js";
import type { HandoffResult } from "../cloud/handoff.js";

// --- Mocks for the runContextSnapshot pipeline (collaborators are exercised in
// their own suites; here we drive run.ts's orchestration + gate branches). ---
const captureContext = vi.fn<() => { text: string; capturedAt: string }>();
vi.mock("./capture.js", () => ({ captureContext: () => captureContext() }));

const anonymize = vi.fn<() => unknown>();
vi.mock("../anonymize/index.js", () => ({ anonymize: () => anonymize() }));

const captureDeclaredMcpServers = vi.fn<() => unknown>();
vi.mock("../capture/claude/mcp-inventory.js", () => ({
  captureDeclaredMcpServers: () => captureDeclaredMcpServers(),
}));

const parseSkillScopesFromContext = vi.fn<() => unknown>();
vi.mock("./skill-scopes.js", () => ({
  parseSkillScopesFromContext: () => parseSkillScopesFromContext(),
}));

const uploadContextSnapshot = vi.fn<() => Promise<SnapshotUploadResult>>();
vi.mock("./upload.js", () => ({ uploadContextSnapshot: () => uploadContextSnapshot() }));

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

const { reportContext, runContextSnapshot } = await import("./run.js");
type ContextReport = Awaited<ReturnType<typeof runContextSnapshot>>;

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

  it("prints the no_change line in default mode", () => {
    const out = captureStdout(() => reportContext({ status: "no_change" }, "default"));
    expect(out).toContain("No change since your last context snapshot");
  });

  it("prints the cap_reached lines (used/cap + reset) in default mode", () => {
    const out = captureStdout(() =>
      reportContext(
        { status: "cap_reached", cap: 7, used: 7, windowResetsAt: "2026-06-21T00:00:00.000Z" },
        "default",
      ),
    );
    expect(out).toContain("Weekly snapshot limit reached (7/7)");
    expect(out).toContain("Resets 2026-06-21T00:00:00.000Z");
  });

  it("prints the auto sign-in line when the handoff is active (default)", () => {
    const active: ContextReport = {
      ...uploaded,
      handoff: {
        active: true,
        dashboardUrl: "https://app/dash",
        expiresAt: "2026-06-06T09:01:00.000Z",
      },
    };
    const out = captureStdout(() => reportContext(active, "default"));
    expect(out).toContain("auto sign-in link");
  });

  it("prints the unavailable line when handoff failed for a non-disabled reason (default)", () => {
    const failed: ContextReport = {
      ...uploaded,
      handoff: { active: false, dashboardUrl: "https://app/dash", reason: "unavailable" },
    };
    const out = captureStdout(() => reportContext(failed, "default"));
    expect(out).toContain("sign-in link unavailable");
  });
});

describe("runContextSnapshot", () => {
  const ctx: SnapshotRunContext = {
    client: {
      cliVersion: "9.9.9",
    } as unknown as SnapshotRunContext["client"],
    session: {
      email: "a@b.test",
    } as unknown as SnapshotRunContext["session"],
    mode: "default",
  };

  beforeEach(() => {
    captureContext.mockReset();
    anonymize.mockReset();
    captureDeclaredMcpServers.mockReset();
    parseSkillScopesFromContext.mockReset();
    uploadContextSnapshot.mockReset();
    requestHandoffUrl.mockReset();

    captureContext.mockReturnValue({ text: "ctx text", capturedAt: "2026-06-06T09:00:00.000Z" });
    anonymize.mockReturnValue({
      payload: "anon",
      policyVersion: "v0.1",
      byteSize: 42,
      contentHashHex: "hash",
      redactionsByCategory: {},
    });
    captureDeclaredMcpServers.mockReturnValue(null);
    parseSkillScopesFromContext.mockReturnValue(null);
    requestHandoffUrl.mockResolvedValue({
      active: false,
      dashboardUrl: "https://app/dash",
      reason: "disabled-default",
    });
  });

  it("returns an uploaded report carrying the manifest + handoff", async () => {
    uploadContextSnapshot.mockResolvedValue({
      status: "uploaded",
      manifestId: "mfst_1",
      sessionId: "sess_1",
      dashboardUrl: "https://app/dash",
    });
    const report = await runContextSnapshot(ctx);
    expect(report).toMatchObject({
      status: "uploaded",
      capturedAt: "2026-06-06T09:00:00.000Z",
      manifestId: "mfst_1",
      sessionId: "sess_1",
      policyVersion: "v0.1",
      byteSize: 42,
    });
    expect(requestHandoffUrl).toHaveBeenCalledOnce();
  });

  it("returns no_change without requesting a handoff", async () => {
    uploadContextSnapshot.mockResolvedValue({ status: "no_change" });
    const report = await runContextSnapshot(ctx);
    expect(report).toEqual({ status: "no_change" });
    expect(requestHandoffUrl).not.toHaveBeenCalled();
  });

  it("returns cap_reached with the window fields, no handoff", async () => {
    uploadContextSnapshot.mockResolvedValue({
      status: "cap_reached",
      cap: 7,
      used: 7,
      windowResetsAt: "2026-06-21T00:00:00.000Z",
    });
    const report = await runContextSnapshot(ctx);
    expect(report).toEqual({
      status: "cap_reached",
      cap: 7,
      used: 7,
      windowResetsAt: "2026-06-21T00:00:00.000Z",
    });
    expect(requestHandoffUrl).not.toHaveBeenCalled();
  });

  it("passes mcpServers and skillScopes onto the upload when present", async () => {
    captureDeclaredMcpServers.mockReturnValue([{ name: "srv", status: "connected" }]);
    parseSkillScopesFromContext.mockReturnValue({ skills: [] });
    uploadContextSnapshot.mockResolvedValue({ status: "no_change" });
    await runContextSnapshot(ctx);
    expect(captureDeclaredMcpServers).toHaveBeenCalledOnce();
    expect(parseSkillScopesFromContext).toHaveBeenCalledOnce();
  });
});

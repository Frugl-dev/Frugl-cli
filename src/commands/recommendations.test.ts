import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadAuthSession } from "../auth/session.js";

vi.mock("../auth/session.js", () => ({ loadAuthSession: vi.fn<() => unknown>() }));

const callMock = vi.fn<(opts: { method: string; path: string }) => Promise<unknown>>();
vi.mock("../cloud/client.js", () => ({
  CloudClient: class {
    call = callMock;
  },
  CloudHttpError: class CloudHttpError extends Error {
    status: number;
    constructor(status: number, _body: unknown, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// Import after mocks are registered.
const { default: Recommendations } = await import("./recommendations.js");

function rec(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    rule_key: "unused_skills",
    target_key: "skillA",
    category: "unused_skills",
    title: "Stop auto-loading the skillA skill",
    description: "Loaded a lot, invoked rarely.",
    estimated_savings_usd: 12.4,
    fix_prompt: "Remove the skill from auto-load.",
    automatable: true,
    status: "open",
    applied_at: null,
    impact: null,
    ...over,
  };
}

let stdout: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  (loadAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    token: "t",
    email: "a@b.test",
    userId: "u1",
  });
});

afterEach(() => vi.restoreAllMocks());

describe("poppi recommendations", () => {
  it("lists recommendations ranked, preserving server order (JSON)", async () => {
    callMock.mockResolvedValue({
      recommendations: [
        rec({ id: "r1", title: "Top", estimated_savings_usd: 20 }),
        rec({ id: "r2", title: "Second", estimated_savings_usd: 5 }),
      ],
    });
    await Recommendations.run(["--json"]);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.recommendations.map((r: { id: string }) => r.id)).toEqual(["r1", "r2"]);
    expect(callMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/recommendations?status=open" }),
    );
  });

  it("prints the ranked list in text mode with rank numbers", async () => {
    callMock.mockResolvedValue({
      recommendations: [rec({ id: "r1", title: "Top" }), rec({ id: "r2", title: "Second" })],
    });
    await Recommendations.run([]);
    expect(stdout).toContain("1.");
    expect(stdout).toContain("Top");
    expect(stdout).toContain("2.");
    expect(stdout).toContain("Second");
  });

  it("--fix prints only the fix prompt", async () => {
    callMock.mockResolvedValue({ recommendations: [rec({ id: "r1", fix_prompt: "DO THE FIX" })] });
    await Recommendations.run(["--fix", "r1"]);
    expect(stdout.trim()).toBe("DO THE FIX");
    expect(callMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/recommendations?status=all" }),
    );
  });

  it("--apply posts to the apply endpoint", async () => {
    callMock.mockResolvedValue({ id: "r1", status: "applied", applied_at: "2026-05-30T00:00:00Z" });
    await Recommendations.run(["--apply", "r1", "--yes", "--json"]);
    expect(callMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/api/recommendations/r1/apply" }),
    );
  });

  it("enriches the list with a category tag, a count, and a total footer", async () => {
    callMock.mockResolvedValue({
      recommendations: [
        rec({
          id: "r1",
          title: "Top",
          category: "root_context_bloat",
          estimated_savings_usd: 312.4,
        }),
        rec({
          id: "r2",
          title: "Second",
          category: "wrong_sized_models",
          estimated_savings_usd: 208,
        }),
      ],
    });
    await Recommendations.run([]);
    // humanized category tags
    expect(stdout).toContain("root context bloat");
    expect(stdout).toContain("wrong sized models");
    // open count in the header
    expect(stdout).toContain("2 open");
    // total footer (312.40 + 208.00)
    expect(stdout).toContain("Estimated total");
    expect(stdout).toContain("~$520.40/mo");
    // top-item fix CTA
    expect(stdout).toContain("poppi recs --fix r1 | claude");
  });

  it("renders the impact view for --status applied (baseline / realized / measuring)", async () => {
    callMock.mockResolvedValue({
      recommendations: [
        rec({
          id: "r1",
          title: "Trim CLAUDE.md",
          status: "applied",
          applied_at: "2026-05-24T00:00:00Z",
          impact: {
            baseline_cost_usd: 312.4,
            baseline_window_days: 30,
            actual_cost_usd: 108.2,
            projected_baseline_cost_usd: 312.4,
            realized_savings_usd: 204.2,
            measurement_status: "available",
          },
        }),
        rec({
          id: "r2",
          title: "Break the retry loop",
          status: "applied",
          applied_at: "2026-05-28T00:00:00Z",
          impact: {
            baseline_cost_usd: 154.75,
            baseline_window_days: 30,
            actual_cost_usd: null,
            projected_baseline_cost_usd: null,
            realized_savings_usd: null,
            measurement_status: "measuring",
          },
        }),
      ],
    });
    await Recommendations.run(["--status", "applied"]);
    expect(callMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/recommendations?status=applied" }),
    );
    expect(stdout).toContain("Applied recommendations");
    expect(stdout).toContain("Baseline");
    expect(stdout).toContain("$108.20/mo"); // measured "Now"
    expect(stdout).toContain("~$204.20/mo saved"); // realized
    expect(stdout).toContain("measuring"); // second rec still gathering data
    expect(stdout).toContain("Total realized so far");
    expect(stdout).toContain("1 measuring");
    expect(stdout).toContain("1 available");
  });

  it("shows a helpful empty state with next steps", async () => {
    callMock.mockResolvedValue({ recommendations: [] });
    await Recommendations.run([]);
    expect(stdout).toContain("No recommendations right now.");
    expect(stdout).toContain("poppi upload");
    expect(stdout).toContain("poppi recs --status dismissed");
  });

  it("fails closed when not logged in (no API calls)", async () => {
    (loadAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(Recommendations.run(["--json"])).rejects.toThrow("exit:10");
    expect(callMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(10);
  });
});

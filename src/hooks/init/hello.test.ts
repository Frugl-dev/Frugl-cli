import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The init hook entangles four side-effecting modules and ends in
// process.exit(0). Mock the modules and intercept exit so the hook's real
// branching logic (bare-invocation guard, update warning, signed-in line) is
// observable. Output is captured off stdout/stderr.
const checkForUpdate = vi.fn<(v: string) => Promise<string | null>>();
const loadAuthSession = vi.fn<(url: string) => Promise<{ email: string } | null>>();
const resolveEndpoint = vi.fn<() => { url: string; resolvedFrom: string }>();

vi.mock("../../lib/update-check.js", () => ({
  checkForUpdate: (v: string) => checkForUpdate(v),
}));
vi.mock("../../auth/session.js", () => ({
  loadAuthSession: (url: string) => loadAuthSession(url),
}));
vi.mock("../../cloud/endpoints.js", () => ({
  resolveEndpoint: () => resolveEndpoint(),
}));

const { default: hook } = await import("./hello.js");

// A sentinel thrown in place of a real process.exit so the test can assert the
// hook reached its clean exit without killing the vitest worker.
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

interface Opts {
  id?: string | undefined;
  argv: string[];
  config: { version: string };
}

function callHook(opts: Opts): Promise<void> {
  // oclif binds the hook with `this` as the command context; tests don't need it.
  return (hook as unknown as (o: Opts) => Promise<void>).call({}, opts);
}

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(typeof code === "number" ? code : undefined);
  });

  checkForUpdate.mockResolvedValue(null);
  loadAuthSession.mockResolvedValue(null);
  resolveEndpoint.mockReturnValue({ url: "https://app.frugl.dev", resolvedFrom: "default" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const out = (): string => stdout.join("");
const err = (): string => stderr.join("");

describe("init hook", () => {
  describe("bare-invocation guard", () => {
    it("renders the landing screen and exits 0 on a truly bare invocation", async () => {
      await expect(
        callHook({ id: undefined, argv: [], config: { version: "1.2.3" } }),
      ).rejects.toBeInstanceOf(ExitCalled);
      const screen = out();
      expect(screen).toContain("frugl");
      expect(screen).toContain("1.2.3");
      expect(screen).toContain("USED MOST");
      expect(screen).toContain("upload");
      expect(screen).toContain("snapshot");
    });

    it("exits with code 0 specifically", async () => {
      const caught = await callHook({
        id: undefined,
        argv: [],
        config: { version: "1.0.0" },
      }).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(ExitCalled);
      expect((caught as ExitCalled).code).toBe(0);
    });

    it("passes straight through (no landing, no exit) when a command id is present", async () => {
      await expect(
        callHook({ id: "upload", argv: [], config: { version: "1.0.0" } }),
      ).resolves.toBeUndefined();
      expect(out()).toBe("");
      expect(process.exit).not.toHaveBeenCalled();
    });

    it("passes straight through when args/flags are present (e.g. --help)", async () => {
      await expect(
        callHook({ id: undefined, argv: ["--help"], config: { version: "1.0.0" } }),
      ).resolves.toBeUndefined();
      expect(out()).toBe("");
    });
  });

  describe("update check", () => {
    it("warns on stderr when a newer version is available", async () => {
      checkForUpdate.mockResolvedValue("9.9.9");
      await callHook({ id: "upload", argv: [], config: { version: "1.0.0" } }).catch(() => {});
      expect(err()).toContain("9.9.9");
      expect(err()).toContain("npm install -g frugl");
      expect(checkForUpdate).toHaveBeenCalledWith("1.0.0");
    });

    it("emits no warning when already up to date", async () => {
      checkForUpdate.mockResolvedValue(null);
      await callHook({ id: "upload", argv: [], config: { version: "1.0.0" } }).catch(() => {});
      expect(err()).toBe("");
    });

    it("runs the update check even on a pass-through (command id present)", async () => {
      await callHook({ id: "recs", argv: [], config: { version: "2.0.0" } }).catch(() => {});
      expect(checkForUpdate).toHaveBeenCalledWith("2.0.0");
    });
  });

  describe("signed-in line", () => {
    it("shows the signed-in email when a session loads", async () => {
      loadAuthSession.mockResolvedValue({ email: "dev@example.com" });
      await callHook({ id: undefined, argv: [], config: { version: "1.0.0" } }).catch(() => {});
      expect(out()).toContain("Signed in as ");
      expect(out()).toContain("dev@example.com");
      expect(out()).not.toContain("Not signed in");
    });

    it("shows the not-signed-in prompt when there is no session", async () => {
      loadAuthSession.mockResolvedValue(null);
      await callHook({ id: undefined, argv: [], config: { version: "1.0.0" } }).catch(() => {});
      expect(out()).toContain("Not signed in yet");
      expect(out()).toContain("frugl login");
    });

    it("treats a session-load rejection as not-signed-in (offline-tolerant)", async () => {
      loadAuthSession.mockRejectedValue(new Error("keychain locked"));
      await callHook({ id: undefined, argv: [], config: { version: "1.0.0" } }).catch(() => {});
      expect(out()).toContain("Not signed in yet");
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EXIT } from "../../lib/exit-codes.js";
import { MockServer } from "../../e2e/helpers/mock-server.js";
import { runCli } from "../../e2e/helpers/spawn.js";
import { clearAuth, injectAuth, makeTestSession } from "../../e2e/helpers/auth.js";

// Spawn-based command tests for the `org` family. Each command resolves the
// active org via GET /api/orgs/me (the cloud models one active org per account);
// create/join then POST to /api/orgs/create or /api/join. We stand up a
// MockServer returning those wire shapes, inject a keychain session for its URL,
// and drive the real CLI through `runCli`.

interface OrgMeBody {
  org: { id: string; name: string; slug: string; member_count?: number };
  membership: { role: string };
}

const ACME: OrgMeBody = {
  org: { id: "o1", name: "Acme", slug: "acme", member_count: 3 },
  membership: { role: "owner" },
};

/** Wire GET /api/orgs/me to return `body` (member), or 409 org_required (none). */
function wireOrgMe(server: MockServer, body: OrgMeBody | "none"): void {
  server.on("GET", "/api/orgs/me", (_req: IncomingMessage, res: ServerResponse) => {
    if (body === "none") {
      server.json(res, 409, { error: "org_required" });
      return;
    }
    server.json(res, 200, body);
  });
}

describe("frugl org commands", { timeout: 30_000 }, () => {
  let server: MockServer;

  beforeEach(async () => {
    server = await new MockServer().start();
    injectAuth(makeTestSession(server.url));
  });

  afterEach(async () => {
    clearAuth(server.url);
    await server.close();
  });

  // ---------------------------------------------------------------------------
  // org ls
  // ---------------------------------------------------------------------------
  describe("org ls", () => {
    it("--format json lists the active org with member_count + active:true", async () => {
      wireOrgMe(server, ACME);
      const { exitCode, stdout } = await runCli([
        "org",
        "ls",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim());
      expect(result.command).toBe("org");
      expect(result.ok).toBe(true);
      expect(result.activeSlug).toBe("acme");
      expect(result.organizations).toEqual([
        { slug: "acme", name: "Acme", role: "owner", member_count: 3, active: true },
      ]);
    });

    it("default format prints the org slug in a table", async () => {
      wireOrgMe(server, ACME);
      const { exitCode, stdout } = await runCli(["org", "ls", "--endpoint", server.url]);
      expect(exitCode).toBe(EXIT.OK);
      expect(stdout).toContain("acme");
    });

    it("409 org_required → exit 0 with an empty org list (JSON)", async () => {
      wireOrgMe(server, "none");
      const { exitCode, stdout } = await runCli([
        "org",
        "ls",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim());
      expect(result.activeSlug).toBeNull();
      expect(result.organizations).toEqual([]);
    });

    it("no stored session → exit 10 (AUTH_FAILURE)", async () => {
      clearAuth(server.url);
      const { exitCode, stderr } = await runCli(["org", "ls", "--endpoint", server.url]);
      expect(exitCode).toBe(EXIT.AUTH_FAILURE);
      expect(stderr).toMatch(/not logged in/i);
    });

    it("server 500 on /api/orgs/me → generic failure (exit 1)", async () => {
      server.on("GET", "/api/orgs/me", (_req, res) => {
        server.json(res, 500, { error: "boom" });
      });
      const { exitCode } = await runCli(["org", "ls", "--endpoint", server.url]);
      expect(exitCode).toBe(EXIT.GENERIC_FAILURE);
    });
  });

  // ---------------------------------------------------------------------------
  // org use <slug>
  // ---------------------------------------------------------------------------
  describe("org use", () => {
    it("--format json on the matching slug reports ok:true", async () => {
      wireOrgMe(server, ACME);
      const { exitCode, stdout } = await runCli([
        "org",
        "use",
        "acme",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim());
      expect(result.command).toBe("org use");
      expect(result.ok).toBe(true);
      expect(result.requested).toBe("acme");
      expect(result.activeSlug).toBe("acme");
    });

    it("--format json on a different slug reports ok:false + switch-unavailable", async () => {
      wireOrgMe(server, ACME);
      const { exitCode, stdout } = await runCli([
        "org",
        "use",
        "other",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      // JSON branch always process.exit(0) — switch is reported as data, not failure.
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim());
      expect(result.ok).toBe(false);
      expect(result.requested).toBe("other");
      expect(result.activeSlug).toBe("acme");
      expect(result.reason).toBe("switch-unavailable");
    });

    it("default format on a different slug exits 1 and explains no switch", async () => {
      wireOrgMe(server, ACME);
      const { exitCode, stdout } = await runCli(["org", "use", "other", "--endpoint", server.url]);
      expect(exitCode).toBe(EXIT.GENERIC_FAILURE);
      expect(stdout).toMatch(/not other/i);
    });

    it("no stored session → exit 10 (AUTH_FAILURE)", async () => {
      clearAuth(server.url);
      const { exitCode, stderr } = await runCli(["org", "use", "acme", "--endpoint", server.url]);
      expect(exitCode).toBe(EXIT.AUTH_FAILURE);
      expect(stderr).toMatch(/not logged in/i);
    });
  });

  // ---------------------------------------------------------------------------
  // org create
  // ---------------------------------------------------------------------------
  describe("org create", () => {
    it("--format json --name creates the org (409 me → POST create)", async () => {
      wireOrgMe(server, "none");
      server.on("POST", "/api/orgs/create", (_req, res) => {
        server.json(res, 200, { org: { id: "o2", name: "New Co", slug: "new-co" } });
      });
      const { exitCode, stdout } = await runCli([
        "org",
        "create",
        "--name",
        "New Co",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim());
      expect(result.command).toBe("org create");
      expect(result.ok).toBe(true);
      expect(result.slug).toBe("new-co");
      expect(result.name).toBe("New Co");
      expect(result.outcome).toBe("created");
    });

    it("--format json when already a member reports outcome:existing", async () => {
      wireOrgMe(server, ACME);
      const { exitCode, stdout } = await runCli([
        "org",
        "create",
        "--name",
        "Whatever",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim());
      expect(result.outcome).toBe("existing");
      expect(result.slug).toBe("acme");
    });

    it("--format json without --name → USAGE (exit 2), no prompt", async () => {
      // No /api/orgs/me wired — the guard fires before any network call.
      const { exitCode, stderr } = await runCli([
        "org",
        "create",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stderr).toMatch(/--name/);
    });

    it("--format json slug_taken (409) hard-fails as USAGE (exit 2)", async () => {
      wireOrgMe(server, "none");
      server.on("POST", "/api/orgs/create", (_req, res) => {
        server.json(res, 409, {
          error: "slug_taken",
          details: { suggestion: "new-co-2" },
        });
      });
      const { exitCode, stderr } = await runCli([
        "org",
        "create",
        "--name",
        "New Co",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stderr).toMatch(/new-co-2/);
    });

    it("no stored session → exit 10 (AUTH_FAILURE)", async () => {
      clearAuth(server.url);
      const { exitCode, stderr } = await runCli([
        "org",
        "create",
        "--name",
        "X",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.AUTH_FAILURE);
      expect(stderr).toMatch(/not logged in/i);
    });
  });

  // ---------------------------------------------------------------------------
  // org join <code>
  // ---------------------------------------------------------------------------
  describe("org join", () => {
    it("--format json joins via invite code (409 me → POST join)", async () => {
      wireOrgMe(server, "none");
      server.on("POST", "/api/join", (_req, res) => {
        server.json(res, 200, { org: { name: "Team Org", slug: "team-org" } });
      });
      const { exitCode, stdout } = await runCli([
        "org",
        "join",
        "pop_inv_abc",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim());
      expect(result.command).toBe("org join");
      expect(result.ok).toBe(true);
      expect(result.slug).toBe("team-org");
      expect(result.outcome).toBe("joined");
    });

    it("--format json when already a member reports outcome:existing", async () => {
      wireOrgMe(server, ACME);
      const { exitCode, stdout } = await runCli([
        "org",
        "join",
        "pop_inv_abc",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim());
      expect(result.outcome).toBe("existing");
      expect(result.slug).toBe("acme");
    });

    it("--format json without a code arg → USAGE (exit 2), no prompt", async () => {
      const { exitCode, stderr } = await runCli([
        "org",
        "join",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stderr).toMatch(/invite code/i);
    });

    it("--format json invalid code (404) hard-fails as USAGE (exit 2)", async () => {
      wireOrgMe(server, "none");
      server.on("POST", "/api/join", (_req, res) => {
        server.json(res, 404, { error: "not_found" });
      });
      const { exitCode, stderr } = await runCli([
        "org",
        "join",
        "pop_inv_bad",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stderr).toMatch(/not found/i);
    });

    it("no stored session → exit 10 (AUTH_FAILURE)", async () => {
      clearAuth(server.url);
      const { exitCode, stderr } = await runCli([
        "org",
        "join",
        "pop_inv_abc",
        "--format",
        "json",
        "--endpoint",
        server.url,
      ]);
      expect(exitCode).toBe(EXIT.AUTH_FAILURE);
      expect(stderr).toMatch(/not logged in/i);
    });
  });
});

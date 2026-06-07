/**
 * SC-004 end-to-end integration test against the real local Docker stack.
 *
 * ## Prerequisites (all must be running before enabling this suite)
 *
 * 1. Supabase + MinIO:  cd ../frugl && pnpm stack:up && bash docker/bootstrap-minio.sh
 * 2. Astro dev server configured with LOCAL Supabase + MinIO:
 *
 *    PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
 *    PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local publishable key from `npx supabase status`>
 *    SUPABASE_SECRET_KEY=<local secret key>
 *    FRUGL_S3_ENDPOINT=http://localhost:9000
 *    FRUGL_S3_ACCESS_KEY_ID=minioadmin
 *    FRUGL_S3_SECRET_ACCESS_KEY=minioadmin
 *    FRUGL_S3_BUCKET=frugl-sessions-dev
 *    FRUGL_S3_REGION=us-east-1
 *
 *    Then: cd ../frugl && pnpm dev
 *
 * ## Enabling
 *
 *    FRUGL_DOCKER_STACK=1 pnpm test src/e2e/docker-stack.e2e.test.ts
 *
 * ## Env vars (all have sensible local-stack defaults)
 *
 *   TEST_ASTRO_URL          Astro dev server (default: http://localhost:4321)
 *   TEST_SUPABASE_URL       Supabase Kong URL (default: http://127.0.0.1:54321)
 *   TEST_SUPABASE_SECRET_KEY  Secret key for admin ops (default: local key from `pnpm stack:up`)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EXIT } from "../lib/exit-codes.js";
import { runCli } from "./helpers/spawn.js";
import { injectAuth, clearAuth } from "./helpers/auth.js";
import type { AuthSession } from "../auth/session.js";
import { makeTempDir, writeTestSessions, type TempDir } from "./helpers/fixtures.js";

const ENABLED = process.env["FRUGL_DOCKER_STACK"] === "1";

const ASTRO_URL = process.env["TEST_ASTRO_URL"] ?? "http://localhost:4321";
const SUPABASE_URL = process.env["TEST_SUPABASE_URL"] ?? "http://127.0.0.1:54321";
// Default is the local Supabase secret key (from `npx supabase status` in the frugl/ repo)
const SUPABASE_SECRET_KEY =
  process.env["TEST_SUPABASE_SECRET_KEY"] ?? "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

// ---------------------------------------------------------------------------
// Admin helpers (direct Supabase REST API — no SDK dependency)
// ---------------------------------------------------------------------------

interface StackUser {
  userId: string;
  email: string;
  orgId: string;
  session: AuthSession;
}

async function adminFetch(apiPath: string, init: RequestInit): Promise<Response> {
  const url = `${SUPABASE_URL}${apiPath}`;
  const headers = new Headers(init.headers as Record<string, string>);
  headers.set("apikey", SUPABASE_SECRET_KEY);
  headers.set("Authorization", `Bearer ${SUPABASE_SECRET_KEY}`);
  return fetch(url, { ...init, headers });
}

async function createStackUser(): Promise<StackUser> {
  const email = `e2e-cli-${Date.now()}-${randomUUID().slice(0, 8)}@frugl.test`;

  // 1. Create Supabase user (email pre-confirmed)
  const createRes = await adminFetch("/auth/v1/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, email_confirm: true, password: randomUUID() }),
  });
  if (!createRes.ok) throw new Error(`createUser: ${createRes.status} ${await createRes.text()}`);
  const { id: userId } = (await createRes.json()) as { id: string };

  // 2. Generate magic link to get a hashed_token
  const linkRes = await adminFetch("/auth/v1/admin/generate_link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!linkRes.ok) throw new Error(`generateLink: ${linkRes.status} ${await linkRes.text()}`);
  const { hashed_token } = (await linkRes.json()) as { hashed_token: string };

  // 3. Exchange hashed_token for a real Supabase JWT access_token via the Astro endpoint
  const verifyRes = await fetch(`${ASTRO_URL}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token_hash: hashed_token, type: "magiclink" }),
  });
  if (!verifyRes.ok) throw new Error(`verify: ${verifyRes.status} ${await verifyRes.text()}`);
  const { user_id, session: sbSession } = (await verifyRes.json()) as {
    user_id: string;
    session: { access_token: string };
  };

  // 4. Create org + membership (required by the frugl middleware)
  const orgId = randomUUID();
  const orgSlug = `e2e-${userId.replace(/-/g, "").slice(0, 16)}`;
  const orgRes = await adminFetch("/rest/v1/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ id: orgId, name: "E2E CLI Test Workspace", slug: orgSlug }),
  });
  if (!orgRes.ok) throw new Error(`createOrg: ${orgRes.status} ${await orgRes.text()}`);

  const memRes = await adminFetch("/rest/v1/memberships", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ org_id: orgId, user_id, role: "owner" }),
  });
  if (!memRes.ok) throw new Error(`createMembership: ${memRes.status} ${await memRes.text()}`);

  const authSession: AuthSession = {
    email,
    userId: user_id,
    token: sbSession.access_token,
    endpointUrl: ASTRO_URL,
    loggedInAt: new Date().toISOString(),
  };

  return { userId, email, orgId, session: authSession };
}

async function deleteStackUser(userId: string, orgId: string): Promise<void> {
  // Delete membership + org first (FK constraint), then auth user
  await adminFetch(`/rest/v1/memberships?org_id=eq.${orgId}`, {
    method: "DELETE",
    headers: {},
  });
  await adminFetch(`/rest/v1/organizations?id=eq.${orgId}`, {
    method: "DELETE",
    headers: {},
  });
  await adminFetch(`/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: {},
  });
}

// ---------------------------------------------------------------------------
// SC-004 full loop against real stack
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)(
  "SC-004 full loop – real local Docker stack",
  { timeout: 120_000 },
  () => {
    let stackUser: StackUser;
    let tmp: TempDir;

    beforeAll(async () => {
      stackUser = await createStackUser();
      injectAuth(stackUser.session);
      tmp = await makeTempDir();
      await writeTestSessions(tmp.dir, 5);
    });

    afterAll(async () => {
      clearAuth(ASTRO_URL);
      await tmp.cleanup();
      await deleteStackUser(stackUser.userId, stackUser.orgId);
    });

    const env = () => ({ FRUGL_HOME_DIR: tmp.dir });
    const endpoint = ASTRO_URL;

    it("whoami returns stored identity (exit 0)", async () => {
      const { exitCode, stdout } = await runCli(["whoami", "--endpoint", endpoint]);
      expect(exitCode).toBe(EXIT.OK);
      expect(stdout).toContain(stackUser.email);
    });

    it("dry-run --inspect writes inspection dir without any network call (exit 0)", async () => {
      const inspectDir = path.join(tmp.dir, "inspect-out");
      const { exitCode, stdout } = await runCli(
        ["upload", "--dry-run", "--inspect", inspectDir, "--endpoint", endpoint],
        { env: env() },
      );
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.dryRun).toBe(true);
      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(inspectDir, "redaction-summary.json"))).toBe(true);
    });

    it("upload --yes succeeds and returns a manifest ID (exit 0)", async () => {
      const { exitCode, stdout } = await runCli(["upload", "--yes", "--endpoint", endpoint], {
        env: env(),
        timeoutMs: 60_000,
      });
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.ok).toBe(true);
      expect(result.manifestId).toBeTruthy();
      expect(result.actualSessionCount).toBe(5);
    });

    it("second upload --yes is a noop (exit 0)", async () => {
      const { exitCode, stdout } = await runCli(["upload", "--yes", "--endpoint", endpoint], {
        env: env(),
        timeoutMs: 60_000,
      });
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.noop).toBe(true);
      expect(result.classification.unchanged).toBe(5);
    });

    it("--limit 1 uploads exactly 1 new session (exit 0)", async () => {
      await writeTestSessions(tmp.dir, 1, "sc004-extra-project");
      const { exitCode, stdout } = await runCli(
        ["upload", "--limit", "1", "--yes", "--endpoint", endpoint],
        { env: env(), timeoutMs: 60_000 },
      );
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.actualSessionCount).toBe(1);
      expect(result.limited).toMatchObject({ active: true });
    });

    it("logout succeeds then whoami returns AUTH_FAILURE (10)", async () => {
      const logout = await runCli(["logout", "--endpoint", endpoint]);
      expect(logout.exitCode).toBe(EXIT.OK);

      // Re-inject so we can re-run the test suite without auth leftover
      // (afterAll clearAuth handles the keychain; this just verifies whoami post-logout)
      const whoami = await runCli(["whoami", "--endpoint", endpoint]);
      expect(whoami.exitCode).toBe(EXIT.AUTH_FAILURE);
    });
  },
);

// ---------------------------------------------------------------------------
// SC-003 upload timing against real stack (200 sessions ≤ 60 s)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)(
  "SC-003 upload timing – real local Docker stack",
  { timeout: 120_000 },
  () => {
    let stackUser: StackUser;
    let tmp: TempDir;

    beforeAll(async () => {
      stackUser = await createStackUser();
      injectAuth(stackUser.session);
      tmp = await makeTempDir();
      // 200 sessions across 4 projects
      for (let proj = 0; proj < 4; proj++) {
        await writeTestSessions(tmp.dir, 50, `sc003-project-${proj}`);
      }
    });

    afterAll(async () => {
      clearAuth(ASTRO_URL);
      await tmp.cleanup();
      await deleteStackUser(stackUser.userId, stackUser.orgId);
    });

    it("full upload of ≤ 200 sessions completes in ≤ 60 s (SC-003)", async () => {
      const start = performance.now();
      const { exitCode, stdout } = await runCli(["upload", "--yes", "--endpoint", ASTRO_URL], {
        env: { FRUGL_HOME_DIR: tmp.dir },
        timeoutMs: 75_000,
      });
      const elapsedMs = performance.now() - start;
      expect(exitCode).toBe(EXIT.OK);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.ok).toBe(true);
      expect(result.actualSessionCount).toBe(200);
      expect(elapsedMs).toBeLessThan(60_000);
    });
  },
);

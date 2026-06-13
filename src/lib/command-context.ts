import { Flags } from "@oclif/core";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import { resolveEndpoint, type Endpoint } from "../cloud/endpoints.js";
import { loadAuthSession, requireAuthSession, type AuthSession } from "../auth/session.js";
import { getCliVersion } from "./cli-version.js";
import { getPendingAuthFailure } from "./config.js";
import { isFruglError, printFruglError } from "./errors.js";
import { resolveDebug, resolveOutputMode, type OutputMode } from "./output-mode.js";
import { color, symbol } from "./theme.js";

export interface CommandFlags {
  json?: boolean | undefined;
  endpoint?: string | undefined;
}

/**
 * How a command relates to the stored session:
 *
 *   "none"     → no session is loaded; the client is built token-less. For
 *                pre-auth commands (`login`, `setup`) that obtain a token mid-run
 *                and call `client.setToken(...)` themselves.
 *   "optional" → a session is loaded if present, otherwise `session` is `null`
 *                and the client is still token-less. For commands that must
 *                degrade gracefully when not logged in (`whoami`, `logout`,
 *                `recommendations`).
 *   "require"  → a session is required; throws `AuthError` (exit 10) when not
 *                logged in. For commands that cannot proceed unauthenticated
 *                (`org *`, `upload`).
 */
export type AuthMode = "none" | "optional" | "require";

type SessionFor<A extends AuthMode> = A extends "require"
  ? AuthSession
  : A extends "optional"
    ? AuthSession | null
    : null;

export interface CommandContext<A extends AuthMode> {
  mode: OutputMode;
  endpoint: Endpoint;
  /** Token already set when a session exists ("optional" with a session, or "require"). */
  client: CloudClient;
  session: SessionFor<A>;
}

/**
 * The shared command preamble: output mode, endpoint resolution (incl. the
 * `FRUGL_ENDPOINT` env read and the precedence flag > env > default), CLI
 * version lookup, the session load/require policy, and CloudClient construction
 * with the `endpointExplicit === (resolvedFrom !== "default")` rule.
 *
 * This is the single place that knows those invariants — generalising the
 * org-only `org/runtime.ts:authedClient` shape across every command.
 */
export async function buildCommandContext<A extends AuthMode>(
  flags: CommandFlags,
  opts: { auth: A },
): Promise<CommandContext<A>> {
  const mode = resolveOutputMode({ json: flags.json });
  const endpoint = resolveEndpoint({
    flag: flags.endpoint,
    env: process.env["FRUGL_ENDPOINT"],
  });

  // Surface a prior background auth failure (hook/CI) the moment the user runs an
  // interactive command that needs auth — before we try, and fail, the same way.
  if (opts.auth !== "none") warnPendingAuthFailure(mode, endpoint.url);

  let session: AuthSession | null;
  if (opts.auth === "require") {
    session = await requireAuthSession(endpoint.url);
  } else if (opts.auth === "optional") {
    session = await loadAuthSession(endpoint.url);
  } else {
    session = null;
  }

  const client = new CloudClient({
    endpointUrl: endpoint.url,
    cliVersion: getCliVersion(),
    endpointExplicit: endpoint.resolvedFrom !== "default",
    debug: resolveDebug(),
    ...(session ? { token: session.token } : {}),
  });

  return { mode, endpoint, client, session: session as SessionFor<A> };
}

// Human-friendly "how long ago" for the pending-failure warning. Coarse on
// purpose — the user only needs to know it's stale, not the exact second.
function describeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "recently";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.round(hr / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// Warn — once, on stderr — that a background run (the Claude Code hook or CI)
// failed auth for this endpoint. Interactive text mode only: the hook itself
// runs --json on a non-TTY, so it never nags about its own failure. Reading the
// breadcrumb is best-effort; a config glitch must never block the command.
function warnPendingAuthFailure(mode: OutputMode, endpointUrl: string): void {
  if (mode !== "text" || !process.stdout.isTTY) return;
  let pending: ReturnType<typeof getPendingAuthFailure>;
  try {
    pending = getPendingAuthFailure();
  } catch {
    return;
  }
  if (!pending || pending.endpoint !== endpointUrl) return;
  process.stderr.write(
    `${color.warn(`${symbol.warn} Your last automatic upload failed — the access token is no longer valid`)} ${color.dim(`(${describeAgo(pending.at)}).`)}\n` +
      `${color.dim("  Run ")}${color.frog("frugl login")}${color.dim(" to reconnect; the Claude Code hook will resume on its own.")}\n\n`,
  );
}

/**
 * The frozen exit-code dispatch (FR-037), in ONE place. Renders the error via
 * `printFruglError` — the sole source of truth for code selection and message
 * formatting — and exits with the returned code. Expected errors are
 * `FruglError` subclasses and `CloudHttpError` (→ GENERIC_FAILURE). Anything
 * else is re-thrown so it propagates to oclif's handler rather than being
 * swallowed. Return type `never`.
 */
export function handleCommandError(err: unknown, mode: OutputMode): never {
  if (isFruglError(err) || err instanceof CloudHttpError) {
    process.exit(printFruglError(err, mode));
  }
  throw err;
}

/**
 * The endpoint + json flags every cloud-touching command shares. Spread into a
 * command's `static flags` so the duplicated definitions collapse to one place.
 */
export const COMMON_FLAGS = {
  endpoint: Flags.string({ description: "Override the API endpoint" }),
  json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
};

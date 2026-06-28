import { UsageError } from "../lib/errors.js";

export const DEFAULT_ENDPOINT = "https://app.frugl.dev";

// Endpoint precedence: flag ?? pin ?? env ?? saved ?? default.
//
// "saved" is the endpoint persisted at the last successful `frugl login` (see
// lib/config.ts). It sits ABOVE the prod default so a developer who logs in to a
// local stack keeps targeting it without re-passing --endpoint every time, and
// an account that never chose a non-default endpoint still defaults to prod.
//
// "pin" is a checked-in `.frugl.json` (see cloud/project-pin.ts) for the
// self-host case. It slots just BELOW the hand-typed --endpoint flag and ABOVE
// every ambient layer (env, saved, default). This is what makes it a safety
// precaution rather than a footgun: the danger self-hosting fears is *silent*
// misrouting to the public cloud (a stale saved login, a forgotten
// FRUGL_ENDPOINT in a shell profile, the hardcoded default) — the pin overrides
// all of those and, when set, never falls back to the public default. It does
// NOT need to override the flag, because an explicit --endpoint typed on this
// invocation is a deliberate, visible act — so the flag simply wins and IS the
// escape hatch (no separate --force flag). A malformed pin fails closed at load
// time (project-pin.ts validates the URL) rather than degrading to the default.
// Hijack stays defanged regardless: auth is endpoint-scoped, so a malicious repo
// pin you've never logged into yields AuthError on upload, not a silent leak.
export type EndpointSource = "flag" | "pin" | "env" | "saved" | "default";

export interface Endpoint {
  url: string;
  resolvedFrom: EndpointSource;
}

export interface ResolveEndpointInput {
  flag?: string | undefined;
  /** Endpoint declared by a checked-in `.frugl.json` (self-host pin). */
  pinned?: string | undefined;
  env?: string | undefined;
  saved?: string | undefined;
}

export function resolveEndpoint(input: ResolveEndpointInput): Endpoint {
  const raw = input.flag ?? input.pinned ?? input.env ?? input.saved ?? DEFAULT_ENDPOINT;
  const resolvedFrom: EndpointSource =
    input.flag !== undefined
      ? "flag"
      : input.pinned !== undefined
        ? "pin"
        : input.env !== undefined
          ? "env"
          : input.saved !== undefined
            ? "saved"
            : "default";
  const url = validateEndpoint(raw);
  return { url, resolvedFrom };
}

// Best-effort normalize for a persisted/untrusted endpoint string: returns the
// validated URL, or undefined if it fails validation. Used for the `saved`
// layer so a manually-corrupted config endpoint is IGNORED (fall back to the
// default) rather than throwing a UsageError on every command — which would
// brick even `frugl login`/`logout`, the commands you'd use to fix it. Explicit
// flag/env input keeps the strict, throwing path (loud failure on bad input).
export function safeEndpoint(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return validateEndpoint(raw);
  } catch {
    return undefined;
  }
}

function validateEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UsageError(`Invalid endpoint URL: ${raw}`);
  }
  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol === "https:") {
    // ok
  } else if (parsed.protocol === "http:" && isLocalhost) {
    // ok
  } else {
    throw new UsageError(`Endpoint must use https (or http on localhost): ${raw}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

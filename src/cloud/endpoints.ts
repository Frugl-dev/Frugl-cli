import { EndpointError, UsageError } from "../lib/errors.js";

export const DEFAULT_ENDPOINT = "https://app.frugl.dev";

// "saved" is the endpoint persisted at the last successful `frugl login` (see
// lib/config.ts). It sits BELOW the per-invocation overrides (flag, env) and
// ABOVE the prod default, so a developer who logs in to a local stack keeps
// targeting it without re-passing --endpoint every time — but a one-off flag or
// FRUGL_ENDPOINT still wins, and an account that never chose a non-default
// endpoint still defaults to prod. Crucially this is an EXPLICIT, per-user
// choice, not an ambient read of whatever dotenv sits in the cwd — so it can't
// be hijacked into redirecting uploads/login by the directory you happen to be in.
//
// "pin" is the one deliberate exception: a checked-in `.frugl.json` (see
// cloud/project-pin.ts) for the self-host case. It is fail-closed by
// construction — it can only RESTRICT, never silently redirect: it overrides the
// ambient saved/env layers and never falls back to the public default, but a
// *disagreeing* explicit --endpoint is refused (unless --force-endpoint), and
// because auth is endpoint-scoped, a malicious pin you've never logged into
// can't reuse your token (upload → AuthError, not a silent leak).
export type EndpointSource = "flag" | "env" | "saved" | "pin" | "default";

export interface Endpoint {
  url: string;
  resolvedFrom: EndpointSource;
}

export interface ResolveEndpointInput {
  flag?: string | undefined;
  env?: string | undefined;
  saved?: string | undefined;
  /** Endpoint declared by a checked-in `.frugl.json` (self-host pin). */
  pinned?: string | undefined;
  /** Path to the `.frugl.json` that declared the pin (for the refusal message). */
  pinPath?: string | undefined;
  /** Allow an explicit --endpoint to override a disagreeing pin (operator escape hatch). */
  forceEndpoint?: boolean | undefined;
}

export function resolveEndpoint(input: ResolveEndpointInput): Endpoint {
  if (input.pinned !== undefined) {
    // Validate the pin loudly — a malformed pin must NEVER degrade to the public
    // default (that silent fall-through is the exact leak self-hosting fears).
    const pinnedUrl = validateEndpoint(input.pinned);

    // An explicit per-invocation choice (flag, then env) may match the pin, or
    // override it with --force-endpoint; a disagreeing one is refused.
    const explicit = input.flag ?? input.env;
    const explicitSource: EndpointSource = input.flag !== undefined ? "flag" : "env";
    if (explicit !== undefined) {
      const explicitUrl = validateEndpoint(explicit);
      if (explicitUrl === pinnedUrl) return { url: pinnedUrl, resolvedFrom: explicitSource };
      if (input.forceEndpoint) return { url: explicitUrl, resolvedFrom: explicitSource };
      throw new EndpointError(
        `This project pins the Frugl endpoint to ${pinnedUrl}` +
          (input.pinPath ? ` (${input.pinPath})` : "") +
          `, but ${explicitSource === "flag" ? "--endpoint" : "FRUGL_ENDPOINT"} ${explicitUrl} was given. ` +
          `Refusing to send data elsewhere — re-run with --force-endpoint to override.`,
      );
    }

    // No explicit override: the pin wins over the ambient saved layer and the
    // default. A stale "logged into the public cloud" saved endpoint can NOT
    // redirect a pinned repo's uploads.
    return { url: pinnedUrl, resolvedFrom: "pin" };
  }

  const raw = input.flag ?? input.env ?? input.saved ?? DEFAULT_ENDPOINT;
  const resolvedFrom: EndpointSource =
    input.flag !== undefined
      ? "flag"
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

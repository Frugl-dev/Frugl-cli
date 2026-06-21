import { UsageError } from "../lib/errors.js";

export const DEFAULT_ENDPOINT = "https://app.frugl.dev";

// "saved" is the endpoint persisted at the last successful `frugl login` (see
// lib/config.ts). It sits BELOW the per-invocation overrides (flag, env) and
// ABOVE the prod default, so a developer who logs in to a local stack keeps
// targeting it without re-passing --endpoint every time — but a one-off flag or
// FRUGL_ENDPOINT still wins, and an account that never chose a non-default
// endpoint still defaults to prod. Crucially this is an EXPLICIT, per-user
// choice, not an ambient read of whatever dotenv sits in the cwd — so it can't
// be hijacked into redirecting uploads/login by the directory you happen to be in.
export type EndpointSource = "flag" | "env" | "saved" | "default";

export interface Endpoint {
  url: string;
  resolvedFrom: EndpointSource;
}

export interface ResolveEndpointInput {
  flag?: string | undefined;
  env?: string | undefined;
  saved?: string | undefined;
}

export function resolveEndpoint(input: ResolveEndpointInput): Endpoint {
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

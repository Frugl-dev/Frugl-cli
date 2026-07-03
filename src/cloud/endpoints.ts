import { UsageError } from "../lib/errors.js";

export const DEFAULT_ENDPOINT = "https://app.frugl.dev";

// Endpoint precedence: flag ?? pin ?? env ?? default.
//
// "pin" is a checked-in `.frugl.json` (see cloud/project-pin.ts) and is the
// project's source of truth for where it talks to — written by `frugl init`,
// visible in the repo, shared by every clone. There is deliberately NO global
// "endpoint remembered from your last login" layer: that ambient per-user
// state made a login against a local stack silently redirect every later
// command on the machine (including a fresh npm install, which shares the OS
// config store) with nothing in the repo or the invocation explaining why.
//
// The pin slots just BELOW the hand-typed --endpoint flag and ABOVE the
// ambient layers (env, default). This is what makes it a safety precaution
// rather than a footgun: the danger self-hosting fears is *silent* misrouting
// to the public cloud (a forgotten FRUGL_ENDPOINT in a shell profile, the
// hardcoded default) — the pin overrides those and, when set, never falls back
// to the public default. It does NOT need to override the flag, because an
// explicit --endpoint typed on this invocation is a deliberate, visible act —
// so the flag simply wins and IS the escape hatch (no separate --force flag).
// A malformed pin fails closed at load time (project-pin.ts validates the URL)
// rather than degrading to the default. Hijack stays defanged regardless: auth
// is endpoint-scoped, so a malicious repo pin you've never logged into yields
// AuthError on upload, not a silent leak.
export type EndpointSource = "flag" | "pin" | "env" | "default";

export interface Endpoint {
  url: string;
  resolvedFrom: EndpointSource;
}

export interface ResolveEndpointInput {
  flag?: string | undefined;
  /** Endpoint declared by a checked-in `.frugl.json` (self-host pin). */
  pinned?: string | undefined;
  env?: string | undefined;
}

export function resolveEndpoint(input: ResolveEndpointInput): Endpoint {
  const raw = input.flag ?? input.pinned ?? input.env ?? DEFAULT_ENDPOINT;
  const resolvedFrom: EndpointSource =
    input.flag !== undefined
      ? "flag"
      : input.pinned !== undefined
        ? "pin"
        : input.env !== undefined
          ? "env"
          : "default";
  const url = validateEndpoint(raw);
  return { url, resolvedFrom };
}

// Human phrase for WHERE a non-default endpoint came from, for error messages
// that would otherwise dead-end ("Endpoint http://localhost:4321 is
// unreachable" — okay, but who told you localhost?). Keyed to the resolution
// layers above so the fix is always evident: retype the flag, edit the pin,
// unset the env var.
export function describeEndpointSource(source: EndpointSource): string {
  switch (source) {
    case "flag":
      return "set by --endpoint";
    case "pin":
      return "pinned by .frugl.json";
    case "env":
      return "set by FRUGL_ENDPOINT";
    case "default":
      return "the default endpoint";
  }
}

// Best-effort normalize for a persisted/untrusted endpoint string: returns the
// validated URL, or undefined if it fails validation — so a corrupted stored
// value is IGNORED (fall through to the next resolution layer) rather than
// throwing a UsageError on every command — which would brick even
// `frugl login`/`logout`, the commands you'd use to fix it. Explicit flag/env
// input keeps the strict, throwing path (loud failure on bad input).
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

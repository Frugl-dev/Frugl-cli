import { UsageError } from "../lib/errors.js";

export const DEFAULT_ENDPOINT = "https://api.frugl.app";

export type EndpointSource = "flag" | "env" | "default";

export interface Endpoint {
  url: string;
  resolvedFrom: EndpointSource;
}

export interface ResolveEndpointInput {
  flag?: string | undefined;
  env?: string | undefined;
}

export function resolveEndpoint(input: ResolveEndpointInput): Endpoint {
  const raw = input.flag ?? input.env ?? DEFAULT_ENDPOINT;
  const resolvedFrom: EndpointSource =
    input.flag !== undefined ? "flag" : input.env !== undefined ? "env" : "default";
  const url = validateEndpoint(raw);
  return { url, resolvedFrom };
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

import pRetry, { AbortError } from "p-retry";

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  signal?: AbortSignal | undefined;
}

const DEFAULTS = {
  attempts: 3,
  baseMs: 500,
  factor: 2,
  maxMs: 5_000,
} as const;

export interface HttpStatusCarrier {
  status?: number;
  statusCode?: number;
}

export function shouldRetry(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const status = extractStatus(error);
  if (status === undefined) return true;
  if (status === 401 || status === 403 || status === 426) return false;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status >= 400 && status < 500) return false;
  return false;
}

export function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const carrier = error as HttpStatusCarrier;
  return typeof carrier.status === "number"
    ? carrier.status
    : typeof carrier.statusCode === "number"
      ? carrier.statusCode
      : undefined;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseMs = options.baseMs ?? DEFAULTS.baseMs;
  const factor = options.factor ?? DEFAULTS.factor;
  const maxMs = options.maxMs ?? DEFAULTS.maxMs;

  const pRetryOptions = {
    retries: attempts - 1,
    factor,
    minTimeout: baseMs,
    maxTimeout: maxMs,
    randomize: true,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  return pRetry(async (attempt) => {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!shouldRetry(err)) {
        // Pass the original Error (not just its message) so AbortError preserves
        // it verbatim — callers downstream still see `.status` and the concrete
        // error type after a non-retryable abort, not a stripped clone.
        throw new AbortError(err instanceof Error ? err : String(err));
      }
      throw err;
    }
  }, pRetryOptions);
}

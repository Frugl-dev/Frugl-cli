import { ZodError, type ZodTypeAny, type z } from "zod";
import {
  AuthError,
  EndpointError,
  NetworkError,
  FruglError,
  VersionGateError,
} from "../lib/errors.js";
import { EXIT } from "../lib/exit-codes.js";
import { extractStatus } from "../lib/retry.js";
import { checkVersionGate } from "./version-gate.js";

export interface CloudClientOptions {
  endpointUrl: string;
  cliVersion: string;
  token?: string | undefined;
  controlPlaneTimeoutMs?: number;
  bodyPutTimeoutMs?: number;
  /** When true, fetch failures surface as EndpointError(41) instead of NetworkError(40). */
  endpointExplicit?: boolean;
  /** When true (FRUGL_DEBUG=1), log HTTP request/response lines to stderr. */
  debug?: boolean;
}

const DEFAULT_CONTROL_PLANE_TIMEOUT_MS = 8_000;
const DEFAULT_BODY_PUT_TIMEOUT_MS = 60_000;

export class CloudHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "CloudHttpError";
  }
}

export interface CallOptions<T extends ZodTypeAny> {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  schema: T;
  timeoutMs?: number;
  authenticated?: boolean;
}

export class CloudClient {
  readonly endpointUrl: string;
  readonly cliVersion: string;
  private readonly controlPlaneTimeoutMs: number;
  private readonly bodyPutTimeoutMs: number;
  private readonly endpointExplicit: boolean;
  private readonly debug: boolean;
  private firstCallSucceeded = false;
  private token: string | undefined;

  constructor(opts: CloudClientOptions) {
    this.endpointUrl = opts.endpointUrl;
    this.cliVersion = opts.cliVersion;
    this.token = opts.token;
    this.controlPlaneTimeoutMs = opts.controlPlaneTimeoutMs ?? DEFAULT_CONTROL_PLANE_TIMEOUT_MS;
    this.bodyPutTimeoutMs = opts.bodyPutTimeoutMs ?? DEFAULT_BODY_PUT_TIMEOUT_MS;
    this.endpointExplicit = opts.endpointExplicit ?? false;
    this.debug = opts.debug ?? false;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  async call<T extends ZodTypeAny>(opts: CallOptions<T>): Promise<z.infer<T>> {
    const url = `${this.endpointUrl}${opts.path}`;
    const headers: Record<string, string> = {
      "X-Frugl-Client": `frugl-cli/${this.cliVersion}`,
      "X-Frugl-CLI-Version": this.cliVersion,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (opts.authenticated !== false && this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    const timeoutMs = opts.timeoutMs ?? this.controlPlaneTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (this.debug) {
      process.stderr.write(`[frugl:debug] → ${opts.method} ${opts.path}\n`);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? null : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.endpointExplicit && !this.firstCallSucceeded) {
        throw new EndpointError(`Endpoint ${this.endpointUrl} is unreachable: ${message}`);
      }
      throw new NetworkError(`Network error calling ${opts.method} ${opts.path}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (this.debug) {
      process.stderr.write(`[frugl:debug] ← ${response.status} ${opts.method} ${opts.path}\n`);
    }
    this.firstCallSucceeded = true;
    return this.handleResponse(response, opts);
  }

  async putBody(
    url: string,
    body: Uint8Array | Buffer,
    headers: Record<string, string>,
    timeoutMs?: number,
  ): Promise<Response> {
    if (this.debug) {
      process.stderr.write(`[frugl:debug] → PUT <body ${body.byteLength}B>\n`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.bodyPutTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers,
        body,
        signal: controller.signal,
      });
      if (this.debug) {
        process.stderr.write(`[frugl:debug] ← ${response.status} PUT\n`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleResponse<T extends ZodTypeAny>(
    response: Response,
    opts: CallOptions<T>,
  ): Promise<z.infer<T>> {
    if (response.status === 426) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      checkVersionGate(this.cliVersion, body);
      throw new VersionGateError(this.cliVersion, "unknown");
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Authentication failed (${response.status}). Run 'frugl login' to re-authenticate.`,
        response.status,
      );
    }
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => "");
      }
      const bodyDesc =
        typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
      throw new CloudHttpError(
        response.status,
        body,
        `HTTP ${response.status} from ${opts.method} ${opts.path}: ${bodyDesc}`,
      );
    }
    // Some endpoints (OTP request, signout) succeed with 204 / an empty body.
    // There is nothing to validate; return undefined for those callers.
    if (response.status === 204) {
      return undefined as z.infer<T>;
    }
    const raw = await response.text();
    if (raw === "") {
      return undefined as z.infer<T>;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new FruglError(
        `Failed to parse JSON from ${opts.method} ${opts.path}: ${err instanceof Error ? err.message : String(err)}`,
        EXIT.GENERIC_FAILURE,
      );
    }
    try {
      return opts.schema.parse(parsed) as z.infer<T>;
    } catch (err) {
      if (err instanceof ZodError) {
        const offending = err.issues[0]?.path?.join(".") ?? "<root>";
        throw new FruglError(
          `Cloud response schema mismatch on ${opts.method} ${opts.path}: ${offending} (${err.issues[0]?.message ?? "unknown"})`,
          EXIT.GENERIC_FAILURE,
        );
      }
      throw err;
    }
  }
}

export function describeHttpError(err: unknown): string {
  if (err instanceof CloudHttpError) {
    const status = err.status;
    const summary =
      typeof err.body === "string"
        ? err.body.slice(0, 200)
        : JSON.stringify(err.body).slice(0, 200);
    return `HTTP ${status}: ${summary}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isAuthHttpError(err: unknown): boolean {
  const status = extractStatus(err);
  return status === 401 || status === 403;
}

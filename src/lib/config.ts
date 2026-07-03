import Conf from "conf";
import { z } from "zod";
import { NAMESPACES } from "./paths.js";

const CONFIG_SCHEMA_VERSION = 1 as const;

// The sign-in method the user last completed `frugl login` with. Persisted so a
// returning user gets a remembered-default fast path (the picker pre-selects it).
export const loginMethodSchema = z.enum(["github", "google", "otp"]);
export type LoginMethod = z.infer<typeof loginMethodSchema>;

// A breadcrumb dropped when a non-interactive run (the Claude Code hook, CI)
// fails authentication. The background upload has no human watching its stderr,
// so we persist the failure here and surface it the next time the user runs an
// interactive, auth-requiring command — turning a silent dead token into a
// visible "run frugl login". Keyed by endpoint so a failure on one endpoint
// never nags about another. Cleared on the next successful login.
export const pendingAuthFailureSchema = z.object({
  endpoint: z.string().url(),
  at: z.string().datetime(),
});
export type PendingAuthFailure = z.infer<typeof pendingAuthFailureSchema>;

// The server refused the last upload because the org is blocked (seat revoked,
// trial expired, over quota — spec 060). Hook-triggered runs honor this as a
// local verdict cache so a de-seated user's machine doesn't re-do discovery +
// anonymization on every session end just to be refused again. TTL'd (`until`)
// so a re-seated user resumes within a day even with zero interactive runs;
// any successful upload clears it immediately.
export const uploadBlockSchema = z.object({
  endpoint: z.string().url(),
  until: z.string().datetime(),
});
export type UploadBlock = z.infer<typeof uploadBlockSchema>;

// When `frugl hook run` last spawned a background upload. Codex's notify fires
// per TURN (not per session), so without a cooldown a chatty session would
// spawn an upload sweep every few seconds.
export const hookSpawnStampSchema = z.object({
  endpoint: z.string().url(),
  at: z.string().datetime(),
});
export type HookSpawnStamp = z.infer<typeof hookSpawnStampSchema>;

export const fruglConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  linkPrs: z.boolean(),
  // Optional so configs written before these fields existed still validate.
  lastLoginMethod: loginMethodSchema.optional(),
  pendingAuthFailure: pendingAuthFailureSchema.optional(),
  uploadBlocked: uploadBlockSchema.optional(),
  lastHookSpawn: hookSpawnStampSchema.optional(),
  // The API endpoint persisted at the last successful `frugl login`. Lets the
  // installed binary keep targeting a non-default stack (e.g. a local dev
  // server) without re-passing --endpoint/FRUGL_ENDPOINT every command. An
  // invalid stored value is dropped by safeParse (treated as absent), so a
  // corrupted entry degrades to the prod default rather than failing. Resolution
  // precedence lives in cloud/endpoints.ts: flag ?? env ?? saved ?? default.
  endpoint: z.string().url().optional(),
});

export type FruglConfig = z.infer<typeof fruglConfigSchema>;

const DEFAULT_CONFIG: FruglConfig = { schemaVersion: CONFIG_SCHEMA_VERSION, linkPrs: false };

export interface ConfigStoreOptions {
  /** Override the conf state-dir (test isolation). */
  cwd?: string;
}

function store(options: ConfigStoreOptions): Conf<{ data: FruglConfig }> {
  const name = NAMESPACES.config;
  return new Conf<{ data: FruglConfig }>({
    projectName: name,
    defaults: { data: { ...DEFAULT_CONFIG } },
    ...(options.cwd !== undefined ? { cwd: options.cwd, configName: name } : {}),
  });
}

// A schema-version mismatch or unreadable file is treated as defaults, never a
// failure — the config is a convenience, not a contract (FR-003).
export function readConfig(options: ConfigStoreOptions = {}): FruglConfig {
  const parsed = fruglConfigSchema.safeParse(store(options).get("data"));
  return parsed.success ? parsed.data : { ...DEFAULT_CONFIG };
}

// Write a partial update, preserving every other field already on disk. Reading
// through readConfig() first means a fresh/unreadable store falls back to
// defaults rather than dropping co-resident preferences.
function writeConfig(patch: Partial<FruglConfig>, options: ConfigStoreOptions): void {
  const next = { ...readConfig(options), ...patch, schemaVersion: CONFIG_SCHEMA_VERSION };
  store(options).set("data", next);
}

export function getLinkPrs(options: ConfigStoreOptions = {}): boolean {
  return readConfig(options).linkPrs;
}

export function setLinkPrs(value: boolean, options: ConfigStoreOptions = {}): void {
  writeConfig({ linkPrs: value }, options);
}

export function getLastLoginMethod(options: ConfigStoreOptions = {}): LoginMethod | undefined {
  return readConfig(options).lastLoginMethod;
}

export function setLastLoginMethod(value: LoginMethod, options: ConfigStoreOptions = {}): void {
  writeConfig({ lastLoginMethod: value }, options);
}

export function getPendingAuthFailure(
  options: ConfigStoreOptions = {},
): PendingAuthFailure | undefined {
  return readConfig(options).pendingAuthFailure;
}

// Record that a non-interactive run failed auth for `endpoint`. Stamped with the
// current time so the eventual warning can say how long ago it happened.
export function recordPendingAuthFailure(endpoint: string, options: ConfigStoreOptions = {}): void {
  writeConfig({ pendingAuthFailure: { endpoint, at: new Date().toISOString() } }, options);
}

// Clear the breadcrumb after a successful login. No-op unless the stored failure
// is for this same endpoint, so logging into endpoint A never silences a pending
// failure recorded against endpoint B.
export function clearPendingAuthFailure(endpoint: string, options: ConfigStoreOptions = {}): void {
  const current = readConfig(options).pendingAuthFailure;
  if (current?.endpoint === endpoint) {
    writeConfig({ pendingAuthFailure: undefined }, options);
  }
}

// How long a server-side "org blocked" verdict is trusted locally before a
// hook-triggered upload re-checks with the server.
export const UPLOAD_BLOCK_TTL_MS = 12 * 60 * 60 * 1000;

export function getUploadBlocked(options: ConfigStoreOptions = {}): UploadBlock | undefined {
  return readConfig(options).uploadBlocked;
}

export function recordUploadBlocked(endpoint: string, options: ConfigStoreOptions = {}): void {
  const until = new Date(Date.now() + UPLOAD_BLOCK_TTL_MS).toISOString();
  writeConfig({ uploadBlocked: { endpoint, until } }, options);
}

// Endpoint-scoped clear, mirroring clearPendingAuthFailure: unblocking on
// endpoint A must never silence a verdict recorded against endpoint B.
export function clearUploadBlocked(endpoint: string, options: ConfigStoreOptions = {}): void {
  const current = readConfig(options).uploadBlocked;
  if (current?.endpoint === endpoint) {
    writeConfig({ uploadBlocked: undefined }, options);
  }
}

export function getLastHookSpawn(options: ConfigStoreOptions = {}): HookSpawnStamp | undefined {
  return readConfig(options).lastHookSpawn;
}

export function recordLastHookSpawn(
  endpoint: string,
  at: Date,
  options: ConfigStoreOptions = {},
): void {
  writeConfig({ lastHookSpawn: { endpoint, at: at.toISOString() } }, options);
}

// The endpoint remembered from the last successful login (see schema comment).
// undefined when the user has never logged in to a non-default stack — callers
// then fall through to FRUGL_ENDPOINT / the prod default.
export function getSavedEndpoint(options: ConfigStoreOptions = {}): string | undefined {
  return readConfig(options).endpoint;
}

// Persist the endpoint a successful login resolved to, so subsequent commands
// reuse it. Best-effort at the call site (a failed write must never break an
// otherwise-successful sign-in).
export function setSavedEndpoint(endpoint: string, options: ConfigStoreOptions = {}): void {
  writeConfig({ endpoint }, options);
}

// Forget the remembered endpoint — but only when it matches `endpoint`, so
// logging out of stack A never resets a default pointed at stack B. Mirrors
// clearPendingAuthFailure's endpoint-scoped semantics.
export function clearSavedEndpoint(endpoint: string, options: ConfigStoreOptions = {}): void {
  if (readConfig(options).endpoint === endpoint) {
    writeConfig({ endpoint: undefined }, options);
  }
}

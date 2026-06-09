import Conf from "conf";
import { z } from "zod";
import { NAMESPACES } from "./paths.js";

const CONFIG_SCHEMA_VERSION = 1 as const;

// The sign-in method the user last completed `frugl login` with. Persisted so a
// returning user gets a remembered-default fast path (the picker pre-selects it).
export const loginMethodSchema = z.enum(["github", "google", "otp"]);
export type LoginMethod = z.infer<typeof loginMethodSchema>;

export const fruglConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  linkPrs: z.boolean(),
  // Optional so configs written before this field existed still validate.
  lastLoginMethod: loginMethodSchema.optional(),
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

import Conf from "conf";
import { z } from "zod";
import { NAMESPACES } from "./paths.js";

const CONFIG_SCHEMA_VERSION = 1 as const;

export const poppiConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  linkPrs: z.boolean(),
});

export type PoppiConfig = z.infer<typeof poppiConfigSchema>;

const DEFAULT_CONFIG: PoppiConfig = { schemaVersion: CONFIG_SCHEMA_VERSION, linkPrs: false };

export interface ConfigStoreOptions {
  /** Override the conf state-dir (test isolation). */
  cwd?: string;
}

function store(options: ConfigStoreOptions): Conf<{ data: PoppiConfig }> {
  const name = NAMESPACES.config;
  return new Conf<{ data: PoppiConfig }>({
    projectName: name,
    defaults: { data: { ...DEFAULT_CONFIG } },
    ...(options.cwd !== undefined ? { cwd: options.cwd, configName: name } : {}),
  });
}

// A schema-version mismatch or unreadable file is treated as defaults, never a
// failure — the config is a convenience, not a contract (FR-003).
export function readConfig(options: ConfigStoreOptions = {}): PoppiConfig {
  const parsed = poppiConfigSchema.safeParse(store(options).get("data"));
  return parsed.success ? parsed.data : { ...DEFAULT_CONFIG };
}

export function getLinkPrs(options: ConfigStoreOptions = {}): boolean {
  return readConfig(options).linkPrs;
}

export function setLinkPrs(value: boolean, options: ConfigStoreOptions = {}): void {
  store(options).set("data", { schemaVersion: CONFIG_SCHEMA_VERSION, linkPrs: value });
}

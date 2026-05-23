export type OutputMode = "text" | "json";

export interface OutputModeFlags {
  json?: boolean | undefined;
}

export function resolveOutputMode(flags: OutputModeFlags): OutputMode {
  return flags.json ? "json" : "text";
}

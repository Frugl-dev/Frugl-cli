export type OutputMode = "text" | "json";

export interface OutputModeFlags {
  json?: boolean | undefined;
}

export function resolveOutputMode(flags: OutputModeFlags): OutputMode {
  return flags.json ? "json" : "text";
}

export function resolveDebug(): boolean {
  const v = process.env.FRUGL_DEBUG;
  return v === "1" || v === "true";
}

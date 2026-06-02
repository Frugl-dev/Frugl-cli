import { checkbox } from "@inquirer/prompts";
import type { DetectedProvider } from "../sources/providers.js";

export interface SelectProvidersOptions {
  interactive: boolean;
}

// Returns the ids of the supported providers the dev wants to upload.
// Non-interactive: every detected supported provider. Interactive: a checkbox
// with supported providers preselected and selectable, and detected-but-
// unsupported providers shown disabled (never selectable, never uploaded).
export async function selectProviders(
  detected: DetectedProvider[],
  opts: SelectProvidersOptions,
): Promise<string[]> {
  const supported = detected.filter((d) => d.descriptor.supported);
  if (!opts.interactive) {
    return supported.map((d) => d.descriptor.id);
  }
  const choices = detected.map((d) => ({
    name: d.descriptor.supported
      ? d.descriptor.displayName
      : `${d.descriptor.displayName} (not yet supported)`,
    value: d.descriptor.id,
    checked: d.descriptor.supported,
    disabled: d.descriptor.supported ? false : "(not yet supported)",
  }));
  return checkbox({ message: "Which providers should Frugl upload?", choices });
}

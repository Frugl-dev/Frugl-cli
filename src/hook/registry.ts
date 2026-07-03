import type { HookProvider, HookProviderId } from "./provider.js";
import { claudeHookProvider } from "./claude-code.js";
import { codexHookProvider } from "./codex.js";
import { cursorHookProvider } from "./cursor.js";
import { geminiHookProvider } from "./gemini.js";

// Every tool the hook feature can wire up. Order is display order.
export const HOOK_PROVIDERS: readonly HookProvider[] = [
  claudeHookProvider,
  codexHookProvider,
  geminiHookProvider,
  cursorHookProvider,
];

export const HOOK_PROVIDER_IDS = HOOK_PROVIDERS.map((p) => p.id) as HookProviderId[];

export function getHookProvider(id: HookProviderId): HookProvider {
  const provider = HOOK_PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown hook provider: ${id}`);
  return provider;
}

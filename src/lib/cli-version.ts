import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let cached: string | undefined;

export function getCliVersion(): string {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "package.json"),
    path.join(here, "..", "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (typeof pkg.version === "string") {
        cached = pkg.version;
        return cached;
      }
    } catch {
      continue;
    }
  }
  cached = "0.0.0";
  return cached;
}

#!/usr/bin/env node

import { execute } from "@oclif/core";

// Dev-only: load .env from the project root so FRUGL_ENDPOINT etc. apply
// (see .env.example). Already-set shell vars take precedence.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  // no .env present — fall back to shell env / defaults
}

await execute({ development: true, dir: import.meta.url });

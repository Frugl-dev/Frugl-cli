#!/usr/bin/env node
// Make `man frugl` work after `npm install -g frugl`.
//
// npm stopped linking `package.json` "man" entries in v9, so the shipped man
// page (man/frugl.1) is never placed on the MANPATH on its own. This script
// replicates the old behavior: on a GLOBAL install it links the page into the
// prefix's man dir. `man` derives its search path from $PATH (each `.../bin`
// implies `.../share/man`), and the global `frugl` binary already lives in
// `<prefix>/bin`, so `<prefix>/share/man/man1/frugl.1` is found automatically.
//
// It is strictly best-effort: a missing man page is a convenience, never a
// reason to fail an install, so every failure path is swallowed. It no-ops on
// local installs (the repo's own `pnpm install`) where it isn't wanted.

import { mkdirSync, symlinkSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

try {
  // Only act on a global install; a local/dev install should not touch a
  // shared man directory.
  if (process.env.npm_config_global !== "true") process.exit(0);

  const prefix = process.env.npm_config_prefix || process.env.PREFIX;
  if (!prefix) process.exit(0);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.join(here, "..", "man", "frugl.1");
  if (!existsSync(src)) process.exit(0);

  const destDir = path.join(prefix, "share", "man", "man1");
  const dest = path.join(destDir, "frugl.1");
  mkdirSync(destDir, { recursive: true });
  try {
    rmSync(dest, { force: true });
  } catch {
    /* nothing to remove */
  }
  // Prefer a symlink (stays in sync if the package is updated in place); fall
  // back to a copy on filesystems that disallow symlinks.
  try {
    symlinkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
} catch {
  // A man page is a nicety — never let it break `npm install -g frugl`.
}

#!/usr/bin/env node
import { Command } from "commander";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { whoamiCommand } from "./commands/whoami.js";
import { uploadCommand } from "./commands/upload.js";
import { deleteCommand } from "./commands/delete.js";

const program = new Command();

program
  .name("poppi")
  .description("Upload anonymized AI-coding session logs to hosted Poppi.")
  .version("0.0.0");

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(uploadCommand);
program.addCommand(deleteCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`poppi: ${message}\n`);
  process.exit(1);
});

import { Command } from "commander";

export const whoamiCommand = new Command("whoami")
  .description("Print the signed-in user's email.")
  .action(async () => {
    throw new Error("whoami: not implemented");
  });

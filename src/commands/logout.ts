import { Command } from "commander";

export const logoutCommand = new Command("logout")
  .description("Forget the local token and revoke this device's session.")
  .action(async () => {
    throw new Error("logout: not implemented");
  });

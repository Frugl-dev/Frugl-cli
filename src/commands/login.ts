import { Command } from "commander";

export const loginCommand = new Command("login")
  .description("Sign in with an email one-time code; token persisted in OS keychain.")
  .action(async () => {
    throw new Error("login: not implemented — see specs/001-cloud-ingest-platform/spec.md (FR-001..FR-005)");
  });

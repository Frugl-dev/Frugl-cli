import { Command } from "commander";

export const uploadCommand = new Command("upload")
  .description(
    "Discover local AI-coding session sources, anonymize them, and batch-upload to hosted Poppi.",
  )
  .option("--confirm, --yes", "Skip the interactive confirmation prompt.")
  .option("--dry-run", "Anonymize but do not transmit.")
  .option("--inspect", "With --dry-run: write redacted output to a local inspection dir.")
  .option("--endpoint <url>", "Override the API endpoint (e.g. point at local docker stack).")
  .action(async () => {
    throw new Error(
      "upload: not implemented — see specs/001-cloud-ingest-platform/spec.md (FR-006..FR-018)",
    );
  });

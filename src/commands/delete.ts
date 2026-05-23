import { Command } from "commander";

export const deleteCommand = new Command("delete")
  .description("Delete a single upload or the entire account.")
  .option("--upload <id>", "Delete a single upload by id.")
  .option("--account", "Delete the entire account (all uploads, all metadata, the auth identity).")
  .action(async () => {
    throw new Error(
      "delete: not implemented — see specs/001-cloud-ingest-platform/spec.md (FR-036..FR-038)",
    );
  });

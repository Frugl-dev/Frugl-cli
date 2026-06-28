import { Command } from "@oclif/core";
import { runOrgList } from "../../org/list.js";
import { COMMON_FLAGS } from "../../lib/command-context.js";

export default class OrgLs extends Command {
  static override description = "List the orgs you belong to and which is active.";

  static override examples = ["<%= config.bin %> <%= command.id %>"];

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(OrgLs);
    await runOrgList({ endpoint: flags.endpoint, format: flags.format });
  }
}

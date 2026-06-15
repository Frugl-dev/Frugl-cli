import { Command } from "@oclif/core";
import { runOrgList } from "../../org/list.js";
import { COMMON_FLAGS } from "../../lib/command-context.js";

export default class Org extends Command {
  static override description = "Show your active org. See also: org ls, create, join.";

  static override flags = COMMON_FLAGS;

  async run(): Promise<void> {
    const { flags } = await this.parse(Org);
    await runOrgList({ endpoint: flags.endpoint, format: flags.format });
  }
}

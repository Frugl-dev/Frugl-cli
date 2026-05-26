import { Command, Flags } from "@oclif/core";
import { runOrgList } from "../../org/list.js";

export default class Org extends Command {
  static override description = "Show your active org. See also: org ls, create, join, use.";

  static override flags = {
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Org);
    await runOrgList({ endpoint: flags.endpoint, json: flags.json });
  }
}

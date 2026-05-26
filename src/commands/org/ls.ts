import { Command, Flags } from "@oclif/core";
import { runOrgList } from "../../org/list.js";

export default class OrgLs extends Command {
  static override description = "List the orgs you belong to and which is active.";

  static override flags = {
    endpoint: Flags.string({ description: "Override the API endpoint" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON output", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(OrgLs);
    await runOrgList({ endpoint: flags.endpoint, json: flags.json });
  }
}

import type { CloudClient } from "../cloud/client.js";
import { deriveSlug } from "./slug.js";
import { setupOrg, type OrgSetupAction, type OrgSetupResult } from "./setup.js";

export type OrgSetupSuccess = Extract<
  OrgSetupResult,
  { status: "already-setup" | "created" | "joined" }
>;

// Reprompt callbacks. Each returns the value to retry with (a new org name, or a
// new invite code). A handler MAY throw instead of reprompting — e.g. in JSON
// mode a slug conflict is a hard failure, and a create-only command treats a
// join outcome as impossible — and the throw propagates out of the flow.
export interface OrgSetupPrompts {
  onSlugTaken(suggestion: string): Promise<string>;
  onInvalidCode(): Promise<string>;
  onExpiredCode(): Promise<string>;
}

export interface OrgSetupFlowDeps {
  // Injectable for tests; defaults to the real setupOrg.
  setup?: (client: CloudClient, intent: OrgSetupAction) => Promise<OrgSetupResult>;
}

// Owns the create/join retry state machine that all four entry points (login,
// setup, `org create`, `org join`) previously duplicated. Drives setupOrg until
// it reaches a terminal success, delegating every reprompt back to the caller
// via `prompts`. The caller is left with just: build the initial intent, supply
// reprompt/abort handlers, and render the returned success.
export async function runOrgSetupFlow(
  client: CloudClient,
  intent: OrgSetupAction,
  prompts: OrgSetupPrompts,
  deps: OrgSetupFlowDeps = {},
): Promise<OrgSetupSuccess> {
  const setup = deps.setup ?? setupOrg;
  let action = intent;

  // Each iteration either returns a terminal success or reprompts and retries.
  // Sequential awaits are intentional — every retry waits on user input.
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await setup(client, action);
    switch (result.status) {
      case "already-setup":
      case "created":
      case "joined":
        return result;
      case "slug-taken": {
        // eslint-disable-next-line no-await-in-loop
        const name = await prompts.onSlugTaken(result.suggestion);
        action = { action: "create", name, slug: deriveSlug(name) };
        break;
      }
      case "invalid-code": {
        // eslint-disable-next-line no-await-in-loop
        const code = await prompts.onInvalidCode();
        action = { action: "join", code };
        break;
      }
      case "expired-code": {
        // eslint-disable-next-line no-await-in-loop
        const code = await prompts.onExpiredCode();
        action = { action: "join", code };
        break;
      }
    }
  }
}

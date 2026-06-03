import { describe, it, expect, vi } from "vitest";
import { runOrgSetupFlow, type OrgSetupPrompts } from "./flow.js";
import type { OrgSetupAction, OrgSetupResult } from "./setup.js";
import type { CloudClient } from "../cloud/client.js";

const client = {} as CloudClient;

// A scripted setup that returns each queued result in turn and records the
// intents it was called with, so we can assert how the flow retried.
function scriptedSetup(results: OrgSetupResult[]) {
  const intents: OrgSetupAction[] = [];
  const setup = vi.fn<(client: CloudClient, intent: OrgSetupAction) => Promise<OrgSetupResult>>(
    async (_client, intent) => {
      intents.push(intent);
      const next = results.shift();
      if (!next) throw new Error("setup called more times than scripted");
      return next;
    },
  );
  return { setup, intents };
}

function neverPrompts(): OrgSetupPrompts {
  return {
    onSlugTaken: () => {
      throw new Error("onSlugTaken should not be called");
    },
    onInvalidCode: () => {
      throw new Error("onInvalidCode should not be called");
    },
    onExpiredCode: () => {
      throw new Error("onExpiredCode should not be called");
    },
  };
}

describe("runOrgSetupFlow", () => {
  it("returns immediately on a terminal success without prompting", async () => {
    const { setup, intents } = scriptedSetup([
      { status: "created", orgName: "Acme", slug: "acme" },
    ]);

    const result = await runOrgSetupFlow(
      client,
      { action: "create", name: "Acme", slug: "acme" },
      neverPrompts(),
      { setup },
    );

    expect(result).toEqual({ status: "created", orgName: "Acme", slug: "acme" });
    expect(intents).toHaveLength(1);
  });

  it("reprompts for a new name on slug-taken, then succeeds with the new slug", async () => {
    const { setup, intents } = scriptedSetup([
      { status: "slug-taken", suggestion: "acme-1" },
      { status: "created", orgName: "Acme HQ", slug: "acme-hq" },
    ]);
    const onSlugTaken = vi.fn<(suggestion: string) => Promise<string>>(async () => "Acme HQ");

    const result = await runOrgSetupFlow(
      client,
      { action: "create", name: "Acme", slug: "acme" },
      { ...neverPrompts(), onSlugTaken },
      { setup },
    );

    expect(onSlugTaken).toHaveBeenCalledWith("acme-1");
    expect(result.status).toBe("created");
    // Retry used a freshly derived slug from the reprompted name.
    expect(intents[1]).toEqual({ action: "create", name: "Acme HQ", slug: "acme-hq" });
  });

  it("reprompts for a new code on invalid-code, then joins", async () => {
    const { setup, intents } = scriptedSetup([
      { status: "invalid-code" },
      { status: "joined", orgName: "Their Org", slug: "their-org" },
    ]);
    const onInvalidCode = vi.fn<() => Promise<string>>(async () => "GOODCODE");

    const result = await runOrgSetupFlow(
      client,
      { action: "join", code: "BADCODE" },
      { ...neverPrompts(), onInvalidCode },
      { setup },
    );

    expect(onInvalidCode).toHaveBeenCalledOnce();
    expect(result.status).toBe("joined");
    expect(intents[1]).toEqual({ action: "join", code: "GOODCODE" });
  });

  it("reprompts on expired-code", async () => {
    const { setup } = scriptedSetup([
      { status: "expired-code" },
      { status: "joined", orgName: "Org", slug: "org" },
    ]);
    const onExpiredCode = vi.fn<() => Promise<string>>(async () => "FRESH");

    const result = await runOrgSetupFlow(
      client,
      { action: "join", code: "OLD" },
      { ...neverPrompts(), onExpiredCode },
      { setup },
    );

    expect(onExpiredCode).toHaveBeenCalledOnce();
    expect(result.status).toBe("joined");
  });

  it("propagates a handler that throws instead of reprompting (JSON-mode abort)", async () => {
    const { setup } = scriptedSetup([{ status: "slug-taken", suggestion: "acme-1" }]);
    const abort = new Error("slug taken — hard fail in JSON mode");

    await expect(
      runOrgSetupFlow(
        client,
        { action: "create", name: "Acme", slug: "acme" },
        {
          ...neverPrompts(),
          onSlugTaken: () => {
            throw abort;
          },
        },
        { setup },
      ),
    ).rejects.toBe(abort);
    expect(setup).toHaveBeenCalledOnce();
  });
});

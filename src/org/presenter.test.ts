import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeOrgSetupPrompts,
  renderOrgSetupResult,
  type OrgSetupPresentation,
} from "./presenter.js";
import { runOrgSetupFlow } from "./flow.js";
import { UsageError } from "../lib/errors.js";
import type { OrgSetupAction, OrgSetupResult } from "./setup.js";
import type { OrgSetupSuccess } from "./flow.js";
import type { CloudClient } from "../cloud/client.js";

const client = {} as CloudClient;

// Strip ANSI (incl. the ESC byte) so assertions hold whether or not color is on,
// mirroring render.test.ts's helper.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string): string => s.replace(ANSI_RE, "");

// Capture stdout/stderr writes for a callback, restoring the real streams after.
function captureStreams(): {
  out: string[];
  err: string[];
  restore: () => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      err.push(String(chunk));
      return true;
    });
  return {
    out,
    err,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

// A scripted setup that returns each queued result in turn, reused from the
// flow.test.ts pattern, so the wiring test exercises a real retry.
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

// A spec covering both reprompt branches; reprompt stubs return sentinel values
// so we can assert they were (or were not) consulted.
function fullSpec(nameReprompt: () => Promise<string>, codeReprompt: () => Promise<string>) {
  return {
    command: "test",
    reprompt: { name: nameReprompt, code: codeReprompt },
    messages: {
      slugTaken: (suggestion: string) => ({
        warn: `WARN slug taken: ${suggestion}`,
        abort: `ABORT slug taken: ${suggestion}`,
      }),
      invalidCode: { warn: "WARN invalid code", abort: "ABORT invalid code" },
      expiredCode: { warn: "WARN expired code", abort: "ABORT expired code" },
    },
    render: {
      text: (r: OrgSetupSuccess) => `text:${r.status}:${r.orgName}:${r.slug}\n`,
      json: (r: OrgSetupSuccess) => ({ ok: true, status: r.status, slug: r.slug }),
    },
  } satisfies OrgSetupPresentation;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeOrgSetupPrompts — text mode", () => {
  it("warns the spec copy to stderr and returns the reprompt value, threading the suggestion", async () => {
    const nameStub = vi.fn<() => Promise<string>>(async () => "Acme HQ");
    const codeStub = vi.fn<() => Promise<string>>(async () => "GOODCODE");
    const prompts = makeOrgSetupPrompts(fullSpec(nameStub, codeStub), "default");
    const { err, restore } = captureStreams();

    const name = await prompts.onSlugTaken("acme-1");

    restore();
    expect(name).toBe("Acme HQ");
    expect(nameStub).toHaveBeenCalledOnce();
    // The suggestion is threaded into messages.slugTaken.
    expect(err.join("")).toBe("WARN slug taken: acme-1\n");
  });

  it("warns and reprompts on invalid-code and expired-code", async () => {
    const nameStub = vi.fn<() => Promise<string>>(async () => "n");
    const codeStub = vi.fn<() => Promise<string>>(async () => "FRESH");
    const prompts = makeOrgSetupPrompts(fullSpec(nameStub, codeStub), "default");

    const cap1 = captureStreams();
    const invalid = await prompts.onInvalidCode();
    cap1.restore();
    expect(invalid).toBe("FRESH");
    expect(cap1.err.join("")).toBe("WARN invalid code\n");

    const cap2 = captureStreams();
    const expired = await prompts.onExpiredCode();
    cap2.restore();
    expect(expired).toBe("FRESH");
    expect(cap2.err.join("")).toBe("WARN expired code\n");
    expect(codeStub).toHaveBeenCalledTimes(2);
  });
});

describe("makeOrgSetupPrompts — JSON mode", () => {
  it("throws UsageError with the abort copy and never invokes the reprompt stub", () => {
    const nameStub = vi.fn<() => Promise<string>>(async () => "n");
    const codeStub = vi.fn<() => Promise<string>>(async () => "c");
    const prompts = makeOrgSetupPrompts(fullSpec(nameStub, codeStub), "json");
    const { err, restore } = captureStreams();

    // JSON mode hard-fails synchronously before reaching the reprompt; the flow
    // awaits the handler, so the throw propagates either way.
    expect(() => prompts.onSlugTaken("acme-1")).toThrow(UsageError);
    expect(() => prompts.onSlugTaken("acme-1")).toThrow("ABORT slug taken: acme-1");
    expect(() => prompts.onInvalidCode()).toThrow("ABORT invalid code");
    expect(() => prompts.onExpiredCode()).toThrow("ABORT expired code");

    restore();
    expect(nameStub).not.toHaveBeenCalled();
    expect(codeStub).not.toHaveBeenCalled();
    // JSON mode hard-fails silently (no stderr warn line) — the caught
    // UsageError is rendered by the command's printFruglError catch.
    expect(err.join("")).toBe("");
  });
});

describe("makeOrgSetupPrompts — omitted-branch guard", () => {
  // A create-only spec omits the code reprompt; a join-only spec omits name.
  const createOnly = {
    command: "org create",
    reprompt: { name: async () => "n" },
    messages: {
      slugTaken: (s: string) => ({ warn: `w ${s}`, abort: `a ${s}` }),
      invalidCode: { warn: "Unexpected: invalid-code", abort: "Unexpected: invalid-code" },
      expiredCode: { warn: "Unexpected: expired-code", abort: "Unexpected: expired-code" },
    },
    render: {
      text: (r: OrgSetupSuccess) => `${r.slug}\n`,
      json: (r: OrgSetupSuccess) => ({ slug: r.slug }),
    },
  } satisfies OrgSetupPresentation;

  for (const mode of ["default", "json"] as const) {
    it(`throws the abort copy for an omitted code branch in ${mode} mode`, () => {
      const prompts = makeOrgSetupPrompts(createOnly, mode);
      // The guard throws synchronously (a `never`); the flow awaits it, so the
      // throw still propagates out of runOrgSetupFlow either way.
      expect(() => prompts.onInvalidCode()).toThrow(UsageError);
      expect(() => prompts.onInvalidCode()).toThrow("Unexpected: invalid-code");
      expect(() => prompts.onExpiredCode()).toThrow("Unexpected: expired-code");
    });
  }

  it("throws the abort copy for an omitted name (slug-taken) branch", () => {
    const joinOnly = {
      command: "org join",
      reprompt: { code: async () => "c" },
      messages: {
        slugTaken: () => ({
          warn: "Unexpected: slug-taken",
          abort: "Unexpected: slug-taken",
        }),
        invalidCode: { warn: "w", abort: "a" },
        expiredCode: { warn: "w", abort: "a" },
      },
      render: {
        text: (r: OrgSetupSuccess) => `${r.slug}\n`,
        json: (r: OrgSetupSuccess) => ({ slug: r.slug }),
      },
    } satisfies OrgSetupPresentation;
    const prompts = makeOrgSetupPrompts(joinOnly, "default");
    expect(() => prompts.onSlugTaken("acme-1")).toThrow("Unexpected: slug-taken");
  });
});

describe("renderOrgSetupResult", () => {
  const spec = fullSpec(
    async () => "n",
    async () => "c",
  );
  const cases: { status: OrgSetupSuccess["status"]; result: OrgSetupSuccess }[] = [
    { status: "created", result: { status: "created", orgName: "Acme", slug: "acme" } },
    { status: "joined", result: { status: "joined", orgName: "Their Org", slug: "their-org" } },
    {
      status: "already-setup",
      result: { status: "already-setup", orgName: "Existing", slug: "existing" },
    },
  ];

  for (const { status, result } of cases) {
    it(`renders ${status} to stdout in text mode (ANSI-stripped)`, () => {
      const { out, err, restore } = captureStreams();
      renderOrgSetupResult(result, spec, "default");
      restore();
      expect(plain(out.join(""))).toBe(`text:${status}:${result.orgName}:${result.slug}\n`);
      expect(err.join("")).toBe("");
    });

    it(`renders ${status} to stdout as a JSON envelope`, () => {
      const { out, restore } = captureStreams();
      renderOrgSetupResult(result, spec, "json");
      restore();
      expect(JSON.parse(out.join(""))).toEqual({
        ok: true,
        status,
        slug: result.slug,
      });
      // One newline-terminated line.
      expect(out.join("").endsWith("\n")).toBe(true);
    });
  }
});

describe("wiring through runOrgSetupFlow", () => {
  it("reprompts on slug-taken then renders the created success end-to-end (text)", async () => {
    const { setup, intents } = scriptedSetup([
      { status: "slug-taken", suggestion: "acme-1" },
      { status: "created", orgName: "Acme HQ", slug: "acme-hq" },
    ]);
    const nameStub = vi.fn<() => Promise<string>>(async () => "Acme HQ");
    const spec = fullSpec(nameStub, async () => "c");

    const { out, err, restore } = captureStreams();
    const result = await runOrgSetupFlow(
      client,
      { action: "create", name: "Acme", slug: "acme" },
      makeOrgSetupPrompts(spec, "default"),
      { setup },
    );
    renderOrgSetupResult(result, spec, "default");
    restore();

    // The slug-taken handler was consulted with the suggestion and warned.
    expect(nameStub).toHaveBeenCalledOnce();
    expect(err.join("")).toBe("WARN slug taken: acme-1\n");
    // Retry used a freshly derived slug from the reprompted name.
    expect(intents[1]).toEqual({ action: "create", name: "Acme HQ", slug: "acme-hq" });
    // Final render reflects the terminal success.
    expect(result.status).toBe("created");
    expect(plain(out.join(""))).toBe("text:created:Acme HQ:acme-hq\n");
  });

  it("hard-fails on slug-taken in JSON mode without reprompting or rendering", async () => {
    const { setup } = scriptedSetup([{ status: "slug-taken", suggestion: "acme-1" }]);
    const nameStub = vi.fn<() => Promise<string>>(async () => "Acme HQ");
    const spec = fullSpec(nameStub, async () => "c");

    await expect(
      runOrgSetupFlow(
        client,
        { action: "create", name: "Acme", slug: "acme" },
        makeOrgSetupPrompts(spec, "json"),
        { setup },
      ),
    ).rejects.toThrow("ABORT slug taken: acme-1");
    expect(nameStub).not.toHaveBeenCalled();
    expect(setup).toHaveBeenCalledOnce();
  });
});

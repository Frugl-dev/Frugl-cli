import { input, password, select } from "@inquirer/prompts";
import { AuthService } from "../auth/auth-service.js";
import type { AuthSession } from "../auth/session.js";
import { cloudIdentityClient } from "../auth/identity-client.js";
import { CloudHttpError, type CloudClient } from "../cloud/client.js";
import type { Endpoint } from "../cloud/endpoints.js";
import { orgMeResponseSchema } from "../cloud/schemas.js";
import { getCliVersion } from "../lib/cli-version.js";
import { UsageError } from "../lib/errors.js";
import type { OutputMode } from "../lib/output-mode.js";
import { runOrgSetupFlow, type OrgSetupSuccess } from "./flow.js";
import { makeOrgSetupPrompts, type OrgSetupPresentation } from "./presenter.js";
import type { OrgSetupAction } from "./setup.js";
import { deriveSlug } from "./slug.js";

// The flags both `setup` and `init` thread into the shared flow. `yes`/`mode`
// gate whether we may prompt: `init --yes` (and any non-interactive run) must
// never block on stdin (FR-005). `setup` has no `--yes`, so it always passes
// `yes: false` and keeps its current interactive behavior unchanged.
export interface OnboardFlags {
  email?: string | undefined;
  orgName?: string | undefined;
  inviteCode?: string | undefined;
  yes?: boolean | undefined;
}

export interface OnboardParams {
  endpoint: Endpoint;
  client: CloudClient;
  mode: OutputMode;
  // The saved session resolved by buildCommandContext (auth: "optional"), or
  // null when the user isn't logged in for this endpoint yet.
  existingSession: AuthSession | null;
  flags: OnboardFlags;
  // Label for the JSON-mode abort copy raised when a non-terminal org outcome
  // can't be reprompted (e.g. a slug conflict under --format json).
  command: string;
  // Which mode the org reprompts are built in. `setup` pins this to "default"
  // (it always reprompts, even under --format json — it has no pre-flow JSON
  // guard), so its behavior is unchanged by the extraction. `init` lets it
  // follow the real output mode, so a JSON run hard-fails instead of blocking.
  repromptMode?: OutputMode | undefined;
}

export interface OnboardResult {
  session: AuthSession;
  orgResult: OrgSetupSuccess;
}

async function promptCode(): Promise<string> {
  const code = await input({
    message: "Invite code:",
    validate: (v) => v.trim().length > 0 || "Enter an invite code",
  });
  return code.trim();
}

function promptName(): Promise<string> {
  return input({
    message: "Organization name (try a different one):",
    validate: (v) => (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
  });
}

// Reprompt + abort copy for the org create/join retry state machine. Shared by
// both commands; the text matches what `setup` printed before the extraction.
function buildPresentation(command: string): OrgSetupPresentation {
  return {
    command,
    reprompt: { name: promptName, code: promptCode },
    messages: {
      slugTaken: (suggestion) => ({
        warn: `frugl: That slug is already taken. Suggested alternative: ${suggestion}`,
        abort: `frugl: That slug is already taken. Suggested alternative: ${suggestion}`,
      }),
      invalidCode: {
        warn: "frugl: Invite code not found. Check the code and try again.",
        abort: "frugl: Invite code not found. Check the code and try again.",
      },
      expiredCode: {
        warn: "frugl: That invite code has expired or been used up.",
        abort: "frugl: That invite code has expired or been used up.",
      },
    },
    // Unused by onboard (the caller renders the returned result), but required
    // by the presentation type; makeOrgSetupPrompts reads only reprompt/messages.
    render: {
      text: (r) => `${r.orgName}\n`,
      json: (r) => ({ orgName: r.orgName, slug: r.slug }),
    },
  };
}

// Step 1 — authenticate. Reuse a saved session when present (FR-004); otherwise
// run the OTP flow interactively. Under `--yes` (or any non-interactive run) we
// must NOT prompt: fall back to a headless credential (FRUGL_TOKEN / prior
// `frugl login`) and, if none exists, fail fast with a usage error rather than
// hanging on a prompt (FR-005).
async function authenticate(params: OnboardParams): Promise<AuthSession> {
  if (params.existingSession) return params.existingSession;

  const auth = new AuthService({
    endpointUrl: params.endpoint.url,
    identity: cloudIdentityClient({
      endpointUrl: params.endpoint.url,
      endpointExplicit: params.endpoint.resolvedFrom !== "default",
      endpointSource: params.endpoint.resolvedFrom,
      cliVersion: getCliVersion(),
    }),
  });

  if (params.flags.yes) {
    // Non-interactive: a headless token (FRUGL_TOKEN) is the only way in — the
    // OTP code can't be typed. resolveRequestAuth throws AuthError when nothing
    // is available; translate that to a usage error so the failure is clearly
    // "you didn't supply credentials", not a transient auth fault.
    if (!process.env["FRUGL_TOKEN"]?.trim()) {
      throw new UsageError(
        "Non-interactive setup needs credentials: run `frugl login` first, or set FRUGL_TOKEN.",
      );
    }
    return auth.resolveRequestAuth({});
  }

  let email = params.flags.email;
  if (!email) {
    email = await input({
      message: "Email:",
      validate: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || "Enter a valid email address",
    });
  }
  await auth.startLogin(email);
  const code = await password({
    message: "6-digit code from email:",
    mask: "*",
    validate: (v) => /^\d{6}$/.test(v) || "Code must be 6 digits",
  });
  return auth.completeLogin(email, code);
}

// The non-prompting outcome for `--yes` with no org flag: the user is already
// in an org. Probe membership directly (the same GET the flow runs first) and
// return that org, or null when they're not in one yet. Failing fast then is
// kinder than creating an org with a guessed name.
async function probeMembership(client: CloudClient): Promise<OrgSetupSuccess | null> {
  try {
    const me = await client.call({
      method: "GET",
      path: "/api/orgs/me",
      schema: orgMeResponseSchema,
    });
    return { status: "already-setup", orgName: me.org.name, slug: me.org.slug };
  } catch (err) {
    if (err instanceof CloudHttpError && err.status === 409) return null;
    throw err;
  }
}

// Step 2 — build the org intent from flags, or ask interactively. The `--yes`
// + no-flag case is handled by the caller via probeMembership (it can't prompt
// and won't guess a name), so this guard is a defensive backstop only.
async function resolveIntent(flags: OnboardFlags, yes: boolean): Promise<OrgSetupAction> {
  if (flags.inviteCode) return { action: "join", code: flags.inviteCode };
  if (flags.orgName) {
    return { action: "create", name: flags.orgName, slug: deriveSlug(flags.orgName) };
  }
  if (yes) {
    throw new UsageError(
      "Non-interactive setup needs an org: pass --org-name to create one or --invite-code to join.",
    );
  }

  const choice = await select({
    message: "Set up your organization:",
    choices: [
      { name: "Create a new organization", value: "create" },
      { name: "Join an existing organization with an invite code", value: "join" },
    ],
  });
  if (choice === "create") {
    const name = await input({
      message: "Organization name:",
      validate: (v) => (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
    });
    return { action: "create", name, slug: deriveSlug(name) };
  }
  const code = await input({
    message: "Invite code:",
    validate: (v) => v.trim().length > 0 || "Enter an invite code",
  });
  return { action: "join", code: code.trim() };
}

// The shared auth + org-setup flow that `setup` and `init` both run. Returns the
// authenticated session and the terminal org result; the CALLER renders the
// outcome (so `setup` keeps its "Setup complete …" line and `init` continues to
// config-write + upload + snapshot). Extracted verbatim from `setup` so there is
// exactly ONE place that owns the OTP + create/join logic (FR-003).
export async function runAuthAndOrgSetup(params: OnboardParams): Promise<OnboardResult> {
  const session = await authenticate(params);
  params.client.setToken(session.token);

  const yes = params.flags.yes ?? false;

  // No org flag given: probe membership before prompting/guessing — a re-run
  // against an already-onboarded account (e.g. `init` after `login`) must
  // return the existing org instead of re-offering create/join (FR-004). Under
  // `--yes` this is also the only non-prompting outcome (FR-005 must not hang,
  // US3 re-run stays safe), so fail fast with a usage error when there's no org
  // yet and we can't prompt.
  if (!params.flags.inviteCode && !params.flags.orgName) {
    const existing = await probeMembership(params.client);
    if (existing) return { session, orgResult: existing };
    if (yes) {
      throw new UsageError(
        "Non-interactive setup needs an org: pass --org-name to create one or --invite-code to join.",
      );
    }
  }

  const intent = await resolveIntent(params.flags, yes);

  const presentation = buildPresentation(params.command);
  const prompts = makeOrgSetupPrompts(presentation, params.repromptMode ?? params.mode);
  const orgResult = await runOrgSetupFlow(params.client, intent, prompts);

  return { session, orgResult };
}

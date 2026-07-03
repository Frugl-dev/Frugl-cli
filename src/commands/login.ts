import { Command, Flags } from "@oclif/core";
import { input, password, select } from "@inquirer/prompts";
import { CloudClient, CloudHttpError } from "../cloud/client.js";
import type { Endpoint } from "../cloud/endpoints.js";
import { AuthService } from "../auth/auth-service.js";
import { cloudIdentityClient } from "../auth/identity-client.js";
import { clearAuthSession } from "../auth/session.js";
import { getCliVersion } from "../lib/cli-version.js";
import { buildCommandContext, COMMON_FLAGS, handleCommandError } from "../lib/command-context.js";
import type { OutputMode } from "../lib/output-mode.js";
import { orgMeResponseSchema, type OrgMeResponse } from "../cloud/schemas.js";
import type { OrgSetupAction } from "../org/setup.js";
import { runOrgSetupFlow } from "../org/flow.js";
import {
  makeOrgSetupPrompts,
  renderOrgSetupResult,
  type OrgSetupPresentation,
} from "../org/presenter.js";
import { deriveSlug } from "../org/slug.js";
import {
  getLastLoginMethod,
  recordProfileOrg,
  setLastLoginMethod,
  setSavedEndpoint,
} from "../lib/config.js";
import { color, symbol, SIGIL } from "../lib/theme.js";
import {
  requestHandoffUrl,
  resolveHandoffPreference,
  type HandoffResult,
} from "../cloud/handoff.js";
import { startBrowserLogin } from "../auth/browser-login.js";

// Human labels for the three sign-in methods, used in the returning-user hint.
const LOGIN_METHOD_LABEL = {
  github: "GitHub",
  google: "Google",
  otp: "Email one-time code",
} as const;

async function promptInviteCode(): Promise<string> {
  const inviteCode = await input({
    message: "Invite code:",
    validate: (v) => v.trim().length > 0 || "Enter an invite code",
  });
  return inviteCode.trim();
}

// Persisting the last method is a best-effort convenience, never load-bearing —
// a failed config write must not break an otherwise-successful sign-in.
function rememberLoginMethod(method: "github" | "google" | "otp"): void {
  try {
    setLastLoginMethod(method);
  } catch {
    /* ignore — the remembered-default fast path is optional */
  }
}

// Remember the endpoint this login resolved to, so the installed binary keeps
// targeting it (e.g. a local dev stack) without re-passing --endpoint on every
// command. Best-effort, like rememberLoginMethod — a config write failure must
// never break an otherwise-successful sign-in. Resolution precedence still puts
// an explicit flag/env above this saved value (see cloud/endpoints.ts).
// Best-effort mirror of the resolved org into the profile cache (null clears it
// on a 409 "no org yet"). A cache write must never break login.
function rememberOrg(endpoint: string, org: OrgMeResponse | null): void {
  try {
    recordProfileOrg(
      endpoint,
      org ? { slug: org.org.slug, name: org.org.name, role: org.membership.role } : null,
    );
  } catch {
    /* ignore — the profile cache is a convenience, not a contract */
  }
}

function rememberEndpoint(url: string): void {
  try {
    setSavedEndpoint(url);
  } catch {
    /* ignore — the remembered-endpoint convenience is optional */
  }
}

function promptOrgName(): Promise<string> {
  return input({
    message: "Organization name (try a different one):",
    validate: (v) => (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
  });
}

export default class Login extends Command {
  static override description = `Sign in with an email one-time code; token persisted in OS keychain.

The endpoint you sign in to is remembered, so later commands target the same
stack without re-passing --endpoint. A one-off --endpoint / FRUGL_ENDPOINT still
overrides it; \`frugl logout\` resets the saved endpoint back to the default.

Exit codes:
  0   success
 10   authentication failed (wrong code or token)
 11   OS keychain unavailable
 40   network error`;

  static override examples = [
    "<%= config.bin %> <%= command.id %>                          # email one-time code (the default)",
    "<%= config.bin %> <%= command.id %> --github                 # sign in with GitHub in the browser",
    "<%= config.bin %> <%= command.id %> --email you@team.com     # skip the email prompt",
    "<%= config.bin %> <%= command.id %> --endpoint https://frugl.yourco.com   # sign in to a self-hosted instance",
  ];

  static override flags = {
    email: Flags.string({ description: "Email address to sign in with" }),
    token: Flags.string({
      description:
        "Store a pre-issued access token for non-interactive use (CI / hooks) instead of the email OTP flow.",
    }),
    google: Flags.boolean({
      description: "Sign in with Google (opens browser).",
      exclusive: ["github", "token"],
    }),
    github: Flags.boolean({
      description: "Sign in with GitHub (opens browser).",
      exclusive: ["google", "token"],
    }),
    ...COMMON_FLAGS,
    // Self-host: override the hidden dev-only `endpoint` from COMMON_FLAGS with a
    // visible, self-host-framed one — but ONLY on `login`. Customers sign in to
    // their own deployment, and login persists the endpoint, so later commands
    // inherit it without re-passing the flag (keeping their --help uncluttered).
    endpoint: Flags.string({
      description:
        "URL of your Frugl instance to sign in to (e.g. https://frugl.yourco.com). Remembered for later commands.",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Login);
    // "none": pre-auth, token-less client. We obtain the token mid-run (OTP or
    // the --token branch) and call client.setToken / persist it ourselves.
    const { mode, endpoint, client } = await buildCommandContext(flags, { auth: "none" });

    // Non-interactive: store a pre-issued access token (no OTP).
    if (flags.token) {
      await this.loginWithToken(flags.token, endpoint, mode);
      return;
    }

    // Browser-based OAuth: opens Google or GitHub sign-in in the default browser,
    // waits for the local callback carrying a freshly-minted PAT, then persists it.
    const oauthProvider = flags.google ? "google" : flags.github ? "github" : null;
    if (oauthProvider) {
      await this.loginWithBrowser(oauthProvider, endpoint, mode);
      return;
    }

    // Interactive: let the user pick a sign-in method before anything else.
    // Non-interactive (no TTY, --format json/minimal, --email pre-supplied)
    // skips straight to OTP.
    if (mode === "default" && process.stdout.isTTY && !flags.email) {
      // Returning users get a remembered-default fast path: the picker
      // pre-selects whatever they signed in with last time, so re-auth is a
      // single ⏎. GitHub leads the list — devs live there.
      const lastMethod = getLastLoginMethod();
      if (lastMethod) {
        process.stdout.write(
          `${color.dim("  Welcome back — you used ")}${color.bold(LOGIN_METHOD_LABEL[lastMethod])}${color.dim(" last time.")}\n`,
        );
      }
      const method = await select({
        message: "Sign in with:",
        default: lastMethod,
        choices: [
          {
            name: "GitHub",
            value: "github",
            description: "Opens your browser · recommended for devs",
          },
          { name: "Google", value: "google", description: "Opens your browser" },
          { name: "Email one-time code", value: "otp", description: "6-digit code, no password" },
        ],
      });
      if (method === "google" || method === "github") {
        await this.loginWithBrowser(method, endpoint, mode);
        return;
      }
    }

    // AuthService owns the OTP flow; `client` (from buildCommandContext) is the
    // token-less CloudClient reused for the post-login /api/orgs/me + org setup
    // flow, which is out of AuthService's scope.
    const auth = new AuthService({
      endpointUrl: endpoint.url,
      identity: cloudIdentityClient({
        endpointUrl: endpoint.url,
        endpointExplicit: endpoint.resolvedFrom !== "default",
        cliVersion: getCliVersion(),
      }),
    });

    let email = flags.email;
    try {
      if (!email) {
        email = await input({
          message: "Email:",
          validate: (value) =>
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || "Enter a valid email address",
        });
      }
      await auth.startLogin(email);
      const code = await password({
        message: "6-digit code from email:",
        mask: "*",
        validate: (value) => /^\d{6}$/.test(value) || "Code must be 6 digits",
      });
      const session = await auth.completeLogin(email, code);
      client.setToken(session.token);
      rememberLoginMethod("otp");
      rememberEndpoint(endpoint.url);

      // Check whether the account already has an org.
      let orgContext: OrgMeResponse | null = null;
      let orgRequired = false;
      try {
        orgContext = await client.call({
          method: "GET",
          path: "/api/orgs/me",
          schema: orgMeResponseSchema,
        });
      } catch (err) {
        if (err instanceof CloudHttpError && err.status === 409) {
          orgRequired = true;
        } else {
          throw err;
        }
      }
      // Cache the resolved org (or clear it on 409) so `frugl config` can show it
      // later without re-hitting the cloud.
      rememberOrg(endpoint.url, orgContext);

      if (mode === "json") {
        const out: Record<string, unknown> = {
          command: "login",
          ok: true,
          email: session.email,
          endpoint: session.endpointUrl,
          userId: session.userId,
        };
        if (orgRequired) out["orgRequired"] = true;
        process.stdout.write(`${JSON.stringify(out)}\n`);
        return;
      }

      process.stdout.write(
        `${color.ok(`${symbol.tick} Signed in as ${session.email}`)}  ${color.dim(`(endpoint: ${session.endpointUrl})`)}\n`,
      );

      if (!orgRequired) {
        if (orgContext) {
          process.stdout.write(
            `${color.dim("  Active org: ")}${color.bold(orgContext.org.name)}  ${color.dim(`(role: ${orgContext.membership.role})`)}\n`,
          );
        }
        const handoff = await requestHandoffUrl(
          client,
          `${endpoint.url}/dashboard`,
          resolveHandoffPreference(undefined, Boolean(process.stdout.isTTY), mode),
        );
        this.printNextSteps(handoff, mode);
        return;
      }

      // No org yet — every Frugl account belongs to one. Offer the fork.
      process.stdout.write(
        `\n${color.bold("You're new here — every Frugl account belongs to an org.")}\n`,
      );
      process.stdout.write(
        color.dim(
          "An org is the team whose AI retros you share. You can be in more than one later.\n\n",
        ),
      );

      const choice = await select({
        message: "What would you like to do?",
        choices: [
          {
            name: "Create a new org",
            value: "create",
            description: "You become the owner. Invite teammates later.",
          },
          {
            name: "Join an existing org",
            value: "join",
            description: "Paste an invite code from a teammate.",
          },
          {
            name: "I'll decide later",
            value: "later",
            description: "Logs you in, but upload is blocked until you have one.",
          },
          {
            name: "Log out — wrong account",
            value: "logout",
            description: "Forget this token; you'll be back at frugl login.",
          },
        ],
      });

      if (choice === "later") {
        process.stdout.write(
          `\n${color.dim("  No problem. Set one up anytime with ")}${color.frog("frugl org create")}${color.dim(" or ")}${color.frog("frugl org join <code>")}${color.dim(".")}\n`,
        );
        process.stdout.write(color.dim("  Upload stays blocked until then.\n"));
        return;
      }

      if (choice === "logout") {
        await clearAuthSession(endpoint.url);
        process.stdout.write(
          `\n${color.ok(`${symbol.tick} Logged out.`)}  ${color.dim("Run ")}${color.frog("frugl login")}${color.dim(" to sign in with a different account.")}\n`,
        );
        return;
      }

      let orgAction: OrgSetupAction;
      if (choice === "create") {
        const name = await input({
          message: "Org name:",
          validate: (v) =>
            (v.trim().length > 0 && v.length <= 80) || "Name must be 1–80 characters",
        });
        orgAction = { action: "create", name, slug: deriveSlug(name) };
      } else {
        const inviteCode = await input({
          message: "Invite code:",
          validate: (v) => v.trim().length > 0 || "Enter an invite code",
        });
        orgAction = { action: "join", code: inviteCode.trim() };
      }

      // The flow drives setup + slug-conflict / bad-code retries; each handler
      // reprompts for the field that failed. (This section is text-only — JSON
      // mode returned above before reaching the org fork, so the prompts and
      // rendering run in text mode.)
      const orgSetupSpec: OrgSetupPresentation = {
        command: "login",
        reprompt: { name: promptOrgName, code: promptInviteCode },
        messages: {
          slugTaken: (suggestion) => ({
            warn: `${color.warn(`${symbol.warn} That slug is already taken.`)} ${color.dim(`Try: ${suggestion}`)}`,
            abort: `${color.warn(`${symbol.warn} That slug is already taken.`)} ${color.dim(`Try: ${suggestion}`)}`,
          }),
          invalidCode: {
            warn: `${color.warn(`${symbol.warn} Invite code not found.`)} ${color.dim("Check the code and try again.")}`,
            abort: `${color.warn(`${symbol.warn} Invite code not found.`)} ${color.dim("Check the code and try again.")}`,
          },
          expiredCode: {
            warn: `${color.warn(`${symbol.warn} That invite code has expired or been used up.`)}`,
            abort: `${color.warn(`${symbol.warn} That invite code has expired or been used up.`)}`,
          },
        },
        render: {
          text: (r) => {
            if (r.status === "created") {
              return `\n${color.ok(`${symbol.tick} Org created.`)}  ${color.dim("You're the owner of ")}${color.bold(r.slug)}${color.dim(".")}\n`;
            }
            if (r.status === "joined") {
              return `\n${color.ok(`${symbol.tick} Joined ${r.slug}`)}  ${color.dim("as member.")}\n`;
            }
            return `\n${color.ok(`${symbol.tick} Active org: ${r.orgName}`)}  ${color.dim(`(${r.slug})`)}\n`;
          },
          json: (r) => ({
            command: "login",
            ok: true,
            slug: r.slug,
            name: r.orgName,
            outcome:
              r.status === "already-setup"
                ? "existing"
                : r.status === "created"
                  ? "created"
                  : "joined",
          }),
        },
      };
      const result = await runOrgSetupFlow(
        client,
        orgAction,
        makeOrgSetupPrompts(orgSetupSpec, "default"),
      );
      renderOrgSetupResult(result, orgSetupSpec, "default");
      const handoff = await requestHandoffUrl(
        client,
        `${endpoint.url}/dashboard`,
        resolveHandoffPreference(undefined, Boolean(process.stdout.isTTY), mode),
      );
      this.printNextSteps(handoff, mode);
      return;
    } catch (err) {
      handleCommandError(err, mode);
    }
  }

  private async loginWithBrowser(
    provider: "google" | "github",
    endpoint: Endpoint,
    mode: OutputMode,
  ): Promise<void> {
    try {
      const { token, email, userId } = await startBrowserLogin({
        provider,
        endpointUrl: endpoint.url,
      });

      const auth = new AuthService({
        endpointUrl: endpoint.url,
        identity: cloudIdentityClient({
          endpointUrl: endpoint.url,
          endpointExplicit: endpoint.resolvedFrom !== "default",
          cliVersion: getCliVersion(),
        }),
      });
      const session = await auth.loginWithToken(token);
      rememberLoginMethod(provider);
      rememberEndpoint(endpoint.url);

      const authedClient = new CloudClient({
        endpointUrl: endpoint.url,
        cliVersion: getCliVersion(),
        endpointExplicit: endpoint.resolvedFrom !== "default",
        token,
      });

      // Resolve the active org purely to label the terminal (and carry the
      // orgRequired flag in JSON). Onboarding itself is owned by the browser: the
      // callback page has already sent this web-authenticated tab to /dashboard,
      // where the cloud middleware bounces a no-org account into org setup. We do
      // NOT prompt for org setup here — that would double up with the browser.
      // A 409 just means "no org yet".
      let orgContext: OrgMeResponse | null = null;
      let orgRequired = false;
      try {
        orgContext = await authedClient.call({
          method: "GET",
          path: "/api/orgs/me",
          schema: orgMeResponseSchema,
        });
      } catch (err) {
        if (err instanceof CloudHttpError && err.status === 409) {
          orgRequired = true;
        } else {
          throw err;
        }
      }
      rememberOrg(endpoint.url, orgContext);

      if (mode === "json") {
        const out: Record<string, unknown> = {
          command: "login",
          ok: true,
          email: session.email || email,
          endpoint: session.endpointUrl,
          userId: session.userId || userId,
          provider,
        };
        if (orgRequired) out["orgRequired"] = true;
        process.stdout.write(`${JSON.stringify(out)}\n`);
        return;
      }
      process.stdout.write(
        `${color.ok(`${symbol.tick} Signed in as ${session.email || email}`)}  ${color.dim(`(via ${provider})`)}\n`,
      );

      if (orgRequired) {
        // New account: the browser is already on the onboarding screen.
        process.stdout.write(
          `\n${color.dim("  New here — finish setting up your org in the browser to start uploading.")}\n`,
        );
      } else {
        if (orgContext) {
          process.stdout.write(
            `${color.dim("  Active org: ")}${color.bold(orgContext.org.name)}  ${color.dim(`(role: ${orgContext.membership.role})`)}\n`,
          );
        }
        process.stdout.write(`\n${color.dim("  Your browser is opening your dashboard…")}\n`);
      }

      this.printNextStepsBody(mode);
    } catch (err) {
      handleCommandError(err, mode);
    }
  }

  private async loginWithToken(token: string, endpoint: Endpoint, mode: OutputMode): Promise<void> {
    try {
      const auth = new AuthService({
        endpointUrl: endpoint.url,
        identity: cloudIdentityClient({
          endpointUrl: endpoint.url,
          endpointExplicit: endpoint.resolvedFrom !== "default",
          cliVersion: getCliVersion(),
        }),
      });
      const session = await auth.loginWithToken(token);
      rememberEndpoint(endpoint.url);

      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            command: "login",
            ok: true,
            email: session.email,
            endpoint: session.endpointUrl,
            userId: session.userId,
            headless: true,
          })}\n`,
        );
        return;
      }
      process.stdout.write(
        `${color.ok(`${symbol.tick} Stored access token for ${session.email}`)}  ${color.dim(`(endpoint: ${session.endpointUrl})`)}\n`,
      );
    } catch (err) {
      handleCommandError(err, mode);
    }
  }

  // Agents/CI (`--format minimal`) get one grep-able line instead of the
  // decorated dashboard block + "Next:" tips — the confirmation line printed
  // just above already covers "did it work."
  private printNextSteps(handoff: HandoffResult, mode: OutputMode): void {
    if (mode !== "default") {
      process.stdout.write(
        `dashboard=${handoff.dashboardUrl}${handoff.active ? " active=true" : ""}\n`,
      );
      return;
    }
    process.stdout.write(
      `\n${color.dim("  Dashboard: ")}${color.frog(color.underline(handoff.dashboardUrl))}\n`,
    );
    if (handoff.active) {
      process.stdout.write(color.dim("             auto sign-in link — valid for ~60s\n"));
    }
    this.printNextStepsBody(mode);
  }

  // The "Next" command list and brand closer, shared by every successful sign-in.
  // The browser path prints this without a handoff URL — the already-authenticated
  // browser tab has carried the user straight to the dashboard.
  private printNextStepsBody(mode: OutputMode): void {
    if (mode !== "default") return;
    process.stdout.write(`\n${color.dim("  Next:")}\n`);
    process.stdout.write(
      `${color.dim("    ")}${color.frog("frugl hook install --global")}${color.dim("   auto-upload on session end")}\n`,
    );
    process.stdout.write(
      `${color.dim("    ")}${color.frog("frugl upload --dry-run")}${color.dim("         preview what would be sent")}\n`,
    );
    process.stdout.write(
      `${color.dim("    ")}${color.frog("frugl upload")}${color.dim("                   upload your first batch")}\n`,
    );
    // The brand closer — the same sign-off that threads through the hello and
    // the upload payoff. "You're in." (cf. the web callback page).
    process.stdout.write(`\n  ${color.frog(SIGIL)}  ${color.dim("You're in. Stay green.")}\n`);
  }
}

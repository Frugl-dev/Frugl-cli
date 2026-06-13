import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { color } from "../lib/theme.js";

export type OAuthProvider = "google" | "github";

export interface BrowserLoginResult {
  token: string;
  email: string;
  userId: string;
}

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", github: "GitHub" };

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

// Read the Frugl frog mark from the brand asset so the callback page stays in
// sync with the canonical icon. The file is inlined at startup; the local auth
// server serves no static assets.
const FROG_SVG = readFileSync(new URL("../../brand/frugl-icon.svg", import.meta.url), "utf8");

// The branded "You're in." landing page. Cream surface, frog mark + check badge,
// a confident headline, then it sends the (already web-authenticated) browser on
// to the dashboard. New accounts with no org are bounced to onboarding by the
// cloud middleware — so we always aim at /dashboard and let the cloud route.
// A visible button is the manual fallback if the auto-redirect is blocked.
// Mirrors the design's CallbackPage.
function renderCallbackPage(email: string | null, dashboardUrl: string): string {
  const who = email
    ? `Signed in as <span style="color:#191921;font-weight:600">${escapeHtml(email)}</span>. `
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Frugl — signed in</title></head>
<body style="margin:0">
<div style="height:100vh;background:#f4f2ec;font-family:system-ui,-apple-system,'Geist',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;overflow:hidden;text-align:center;padding:0 32px">
  <div style="position:absolute;top:-22%;left:50%;width:620px;height:620px;transform:translateX(-50%);border-radius:50%;background:radial-gradient(circle,rgba(76,194,133,0.18),rgba(76,194,133,0) 68%);filter:blur(8px);pointer-events:none"></div>
  <div style="position:relative;margin-bottom:30px">
    ${FROG_SVG}
    <div style="position:absolute;right:-8px;bottom:-6px;width:34px;height:34px;border-radius:50%;background:#1f9d5c;border:3px solid #f4f2ec;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(15,98,56,0.3)">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>
    </div>
  </div>
  <div style="font-size:13px;font-weight:500;letter-spacing:0.22em;text-transform:uppercase;color:#1f9d5c;margin-bottom:18px">Signed in</div>
  <h1 style="margin:0;font-size:66px;font-weight:900;letter-spacing:-0.035em;line-height:1;color:#191921">You&rsquo;re in.</h1>
  <p style="margin:20px 0 0;max-width:460px;font-size:19px;line-height:1.5;color:#5f5b66">${who}Taking you to your dashboard&hellip;</p>
  <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;margin-top:30px;padding:14px 28px;border-radius:12px;background:#1f9d5c;color:#fff;font-size:16px;font-weight:600;text-decoration:none;box-shadow:0 6px 18px rgba(15,98,56,0.28)">Go to your dashboard&nbsp;&rarr;</a>
  <div style="position:absolute;bottom:26px;left:0;right:0;font-size:12px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:#a8a39a">Redirecting in a moment&nbsp;&nbsp;·&nbsp;&nbsp;frugl.dev</div>
</div>
<script>setTimeout(function(){window.location.href=${JSON.stringify(dashboardUrl)}},3000)</script>
</body></html>`;
}

// Launch the platform browser WITHOUT a shell. The URL embeds the (env/flag
// controlled) endpoint, so routing it through `exec`'s shell would turn an
// endpoint like https://x.com/$(…) into command execution.
function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    execFile("open", [url]);
  } else if (process.platform === "win32") {
    // `start` is a cmd builtin and re-parses metacharacters; rundll32's URL
    // handler takes the URL as a plain argument instead.
    execFile("rundll32", ["url.dll,FileProtocolHandler", url]);
  } else {
    execFile("xdg-open", [url]);
  }
}

// Constant-time string comparison for the state nonce.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function renderErrorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Frugl — sign-in failed</title></head>
<body style="margin:0">
<div style="height:100vh;background:#f4f2ec;font-family:system-ui,-apple-system,'Geist',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 32px">
  <h1 style="margin:0;font-size:44px;font-weight:900;letter-spacing:-0.03em;color:#191921">Sign-in failed.</h1>
  <p style="margin:20px 0 0;max-width:460px;font-size:18px;line-height:1.5;color:#5f5b66">${escapeHtml(message)} Head back to your terminal and run <code>frugl login</code> again.</p>
</div>
</body></html>`;
}

// Starts a temporary local HTTP server on a random port, opens the browser to
// the Frugl OAuth flow, and waits up to `timeoutMs` (default 5 min) for the
// CLI callback redirect carrying the minted PAT. Resolves with the token on
// success; rejects on timeout or if the user closes the terminal.
//
// CSRF/fixation defense: a single-use random `state` nonce travels with the
// browser through the cloud's cli-callback route and must come back verbatim.
// A request with a missing or wrong state is answered 403 and — crucially —
// does NOT consume the server, so a local attacker can neither inject their
// own token nor burn the legitimate callback's one shot.
export function startBrowserLogin(opts: {
  provider: OAuthProvider;
  endpointUrl: string;
  timeoutMs?: number;
  // Injectable for tests; defaults to launching the platform browser.
  openUrl?: (url: string) => void;
}): Promise<BrowserLoginResult> {
  const { provider, endpointUrl, timeoutMs = 5 * 60 * 1000, openUrl = openBrowser } = opts;
  const expectedState = randomBytes(32).toString("base64url");

  return new Promise<BrowserLoginResult>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const state = url.searchParams.get("state");
      if (!state || !safeEqual(state, expectedState)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderErrorPage("This sign-in attempt could not be verified."));
        return;
      }

      const token = url.searchParams.get("token");
      const email = url.searchParams.get("email");
      const userId = url.searchParams.get("userId");

      server.close();
      clearTimeout(timer);

      if (!token || !email || !userId) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderErrorPage("The sign-in response was incomplete."));
        reject(new Error("OAuth callback missing required fields"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderCallbackPage(email, `${endpointUrl}/dashboard`));
      resolve({ token, email, userId });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start local auth server"));
        return;
      }
      const port = addr.port;
      const cliCallbackPath = `/api/auth/cli-callback?port=${port}&state=${expectedState}`;
      const oauthUrl =
        `${endpointUrl}/api/auth/oauth/${provider}` +
        `?redirect_to=${encodeURIComponent(cliCallbackPath)}`;

      openUrl(oauthUrl);
      // A live waiting state — the terminal stays alive, says exactly what it's
      // waiting for, and resumes itself the second the user approves. Fallback
      // URL and the escape hatch stay visible throughout. Mirrors the design.
      const mins = Math.round(timeoutMs / 60000);
      process.stdout.write(
        `\n${color.frog("⠿")} ${color.bold(`Opening ${PROVIDER_LABEL[provider]} sign-in in your browser…`)}\n\n` +
          `${color.dim("  Waiting for you to authorize Frugl.")}\n` +
          `${color.dim("  This terminal picks back up the second you approve — no codes to copy.")}\n\n` +
          `${color.dim("  Didn't open?  ")}${color.frog(color.underline(oauthUrl))}\n\n` +
          `${color.dim(`  ⌃C cancel · auto-times-out in ${mins} min`)}\n\n`,
      );
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Browser login timed out. Run 'frugl login' to try again."));
    }, timeoutMs);

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

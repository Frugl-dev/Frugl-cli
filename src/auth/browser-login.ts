import { createServer } from "node:http";
import { exec } from "node:child_process";
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

// The Frugl frog mark, inlined so the callback page is fully self-contained
// (the local server serves no static assets).
const FROG_SVG = `<svg viewBox="0 0 32 32" width="92" height="92" role="img" aria-label="Frugl" style="display:block;filter:drop-shadow(0 10px 24px rgba(15,98,56,0.22))">
  <defs><radialGradient id="skin" cx="40%" cy="26%" r="82%">
    <stop offset="0%" stop-color="#4cc285"/><stop offset="55%" stop-color="#1f9d5c"/><stop offset="100%" stop-color="#0f6238"/>
  </radialGradient></defs>
  <circle cx="10" cy="10" r="5.6" fill="url(#skin)"/><circle cx="22" cy="10" r="5.6" fill="url(#skin)"/>
  <path d="M3 17 C3 11 8 8 16 8 C24 8 29 11 29 17 L29 19.5 C29 26 23.5 29 16 29 C8.5 29 3 26 3 19.5 Z" fill="url(#skin)"/>
  <ellipse cx="16" cy="21" rx="9" ry="5.5" fill="#fff" fill-opacity="0.10"/>
  <circle cx="10" cy="9.6" r="3.1" fill="#fff"/><circle cx="22" cy="9.6" r="3.1" fill="#fff"/>
  <circle cx="10.6" cy="10.2" r="1.6" fill="#11261b"/><circle cx="22.6" cy="10.2" r="1.6" fill="#11261b"/>
  <circle cx="9.5" cy="8.8" r="0.6" fill="#fff"/><circle cx="21.5" cy="8.8" r="0.6" fill="#fff"/>
  <circle cx="13.6" cy="15.4" r="0.75" fill="#0c4d2c"/><circle cx="18.4" cy="15.4" r="0.75" fill="#0c4d2c"/>
  <path d="M8.5 19.5 Q16 26.5 23.5 19.5" stroke="#0c4d2c" stroke-width="1.7" fill="none" stroke-linecap="round"/>
</svg>`;

// The branded "You're in." landing page. Cream surface, frog mark + check badge,
// a confident headline, then it points the user back to the terminal and closes
// itself. Mirrors the design's CallbackPage.
function renderCallbackPage(email: string | null): string {
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
  <p style="margin:20px 0 0;max-width:460px;font-size:19px;line-height:1.5;color:#5f5b66">${who}Head back to your terminal — Frugl is already wrapping up.</p>
  <div style="position:absolute;bottom:26px;left:0;right:0;font-size:12px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:#a8a39a">This tab closes itself in a moment&nbsp;&nbsp;·&nbsp;&nbsp;frugl.dev</div>
</div>
<script>setTimeout(function(){window.close()},2500)</script>
</body></html>`;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

// Starts a temporary local HTTP server on a random port, opens the browser to
// the Frugl OAuth flow, and waits up to `timeoutMs` (default 5 min) for the
// CLI callback redirect carrying the minted PAT. Resolves with the token on
// success; rejects on timeout or if the user closes the terminal.
export function startBrowserLogin(opts: {
  provider: OAuthProvider;
  endpointUrl: string;
  timeoutMs?: number;
}): Promise<BrowserLoginResult> {
  const { provider, endpointUrl, timeoutMs = 5 * 60 * 1000 } = opts;

  return new Promise<BrowserLoginResult>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const token = url.searchParams.get("token");
      const email = url.searchParams.get("email");
      const userId = url.searchParams.get("userId");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderCallbackPage(email));
      server.close();
      clearTimeout(timer);

      if (!token || !email || !userId) {
        reject(new Error("OAuth callback missing required fields"));
        return;
      }
      resolve({ token, email, userId });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start local auth server"));
        return;
      }
      const port = addr.port;
      const cliCallbackPath = `/api/auth/cli-callback?port=${port}`;
      const oauthUrl =
        `${endpointUrl}/api/auth/oauth/${provider}` +
        `?redirect_to=${encodeURIComponent(cliCallbackPath)}`;

      openBrowser(oauthUrl);
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

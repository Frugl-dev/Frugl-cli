import { createServer } from "node:http";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";

export type OAuthProvider = "google" | "github";

export interface BrowserLoginResult {
  token: string;
  email: string;
  userId: string;
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

  // One-time nonce bound to this invocation. The server echoes it back in the
  // localhost redirect; mismatches (e.g. a stale or cross-origin callback) are
  // rejected before the token is accepted, preventing unauthorised PAT delivery.
  const state = randomBytes(16).toString("hex");

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
      const returnedState = url.searchParams.get("state");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;text-align:center;padding:4rem">` +
          `<h2>Signed in ✓</h2><p>You can close this tab and return to your terminal.</p>` +
          `</body></html>`,
      );
      server.close();
      clearTimeout(timer);

      if (!token || !email || !userId) {
        reject(new Error("OAuth callback missing required fields"));
        return;
      }
      if (returnedState !== state) {
        reject(new Error("OAuth state mismatch — possible CSRF. Run 'frugl login' to try again."));
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
      const cliCallbackPath = `/api/auth/cli-callback?port=${port}&state=${state}`;
      const oauthUrl =
        `${endpointUrl}/api/auth/oauth/${provider}` +
        `?redirect_to=${encodeURIComponent(cliCallbackPath)}`;

      openBrowser(oauthUrl);
      process.stdout.write(
        `\nOpening ${provider === "google" ? "Google" : "GitHub"} sign-in in your browser…\n` +
          `If it doesn't open, visit:\n  ${oauthUrl}\n\n`,
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

import { Entry } from "@napi-rs/keyring";
import type { AuthSession } from "../../auth/session.js";

const SERVICE = "poppi";

export function injectAuth(session: AuthSession): void {
  new Entry(SERVICE, session.endpointUrl).setPassword(JSON.stringify(session));
}

export function clearAuth(endpointUrl: string): void {
  try {
    new Entry(SERVICE, endpointUrl).deletePassword();
  } catch {
    // already absent — fine
  }
}

export function makeTestSession(endpointUrl: string): AuthSession {
  return {
    email: "tester@poppi-e2e.example",
    userId: "user-e2e-test",
    token: "tok-e2e-test",
    endpointUrl,
    loggedInAt: new Date().toISOString(),
  };
}

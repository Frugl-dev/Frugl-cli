import { z } from "zod";
import { AuthError } from "../lib/errors.js";
import { deleteToken, getToken, setToken } from "./keychain.js";

const authSessionSchema = z.object({
  email: z.string().email(),
  userId: z.string().min(1),
  token: z.string().min(1),
  endpointUrl: z.string().url(),
  loggedInAt: z.string().datetime(),
});

export type AuthSession = z.infer<typeof authSessionSchema>;

export async function saveAuthSession(session: AuthSession): Promise<void> {
  const account = accountFor(session.endpointUrl);
  await setToken(account, JSON.stringify(session));
}

export async function loadAuthSession(endpointUrl: string): Promise<AuthSession | null> {
  const account = accountFor(endpointUrl);
  const raw = await getToken(account);
  if (!raw) return null;
  try {
    const parsed = authSessionSchema.parse(JSON.parse(raw));
    return parsed;
  } catch {
    return null;
  }
}

export async function requireAuthSession(endpointUrl: string): Promise<AuthSession> {
  const session = await loadAuthSession(endpointUrl);
  if (!session) {
    throw new AuthError("Not logged in. Run 'frugl login' to authenticate.");
  }
  return session;
}

export async function clearAuthSession(endpointUrl: string): Promise<void> {
  const account = accountFor(endpointUrl);
  await deleteToken(account);
}

function accountFor(endpointUrl: string): string {
  return endpointUrl;
}

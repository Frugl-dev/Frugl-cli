import { CloudClient } from "../cloud/client.js";
import { otpRequestResponseSchema, otpVerifyResponseSchema } from "../cloud/schemas.js";
import type { AuthSession } from "./session.js";

export async function requestOtp(client: CloudClient, email: string): Promise<void> {
  await client.call({
    method: "POST",
    path: "/api/auth/otp/request",
    body: { email },
    schema: otpRequestResponseSchema,
    authenticated: false,
  });
}

export async function verifyOtp(
  client: CloudClient,
  email: string,
  code: string,
): Promise<AuthSession> {
  const result = await client.call({
    method: "POST",
    path: "/api/auth/otp/verify",
    body: { email, code },
    schema: otpVerifyResponseSchema,
    authenticated: false,
  });
  // The cloud's verify response carries identity + session but not the email
  // (it's account-enumeration sensitive), so we keep the address the user
  // entered. The access token is what the CLI replays as a bearer header.
  return {
    email,
    userId: result.user_id,
    token: result.session.access_token,
    endpointUrl: client.endpointUrl,
    loggedInAt: new Date().toISOString(),
  };
}

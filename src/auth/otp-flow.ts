import { CloudClient } from "../cloud/client.js";
import { otpRequestResponseSchema, otpVerifyResponseSchema } from "../cloud/schemas.js";
import type { AuthSession } from "./session.js";

export async function requestOtp(client: CloudClient, email: string): Promise<void> {
  await client.call({
    method: "POST",
    path: "/auth/otp/request",
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
    path: "/auth/otp/verify",
    body: { email, code },
    schema: otpVerifyResponseSchema,
    authenticated: false,
  });
  return {
    email: result.email,
    userId: result.userId,
    token: result.token,
    endpointUrl: client.endpointUrl,
    loggedInAt: new Date().toISOString(),
  };
}

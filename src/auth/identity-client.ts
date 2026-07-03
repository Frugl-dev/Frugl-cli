import { CloudClient } from "../cloud/client.js";
import type { EndpointSource } from "../cloud/endpoints.js";
import {
  identityResponseSchema,
  otpRequestResponseSchema,
  otpVerifyResponseSchema,
} from "../cloud/schemas.js";

// Network port for the auth endpoints. Keyed by token: each call may
// authenticate as a different bearer (a flag/env token, or a freshly issued OTP
// session token), so the token is passed per-call rather than bound at
// construction. AuthService depends on this interface; production wires in
// `cloudIdentityClient`, tests inject a trivial in-memory fake — so AuthService
// is exercised without HTTP or a real keychain.
export interface IdentityClient {
  // POST /api/auth/otp/request — start the email OTP flow.
  requestOtp(email: string): Promise<void>;
  // POST /api/auth/otp/verify — exchange the code for an identity + token.
  verifyOtp(email: string, code: string): Promise<{ userId: string; token: string }>;
  // GET /api/auth/whoami as `token` — resolve the acting identity for a bearer.
  // A 401/403 (invalid/revoked token) surfaces as AuthError from CloudClient.
  fetchIdentity(token: string): Promise<{ userId: string; email: string }>;
}

export interface CloudIdentityClientOptions {
  endpointUrl: string;
  endpointExplicit: boolean;
  endpointSource?: EndpointSource | undefined;
  cliVersion: string;
}

// Production adapter. Binds one endpoint and builds the per-token CloudClient
// internally — replacing the inline CloudClient construction that previously
// lived in otp-flow.ts (requestOtp/verifyOtp) and headless.ts (fetchIdentity).
export function cloudIdentityClient(opts: CloudIdentityClientOptions): IdentityClient {
  const clientFor = (token?: string): CloudClient =>
    new CloudClient({
      endpointUrl: opts.endpointUrl,
      cliVersion: opts.cliVersion,
      endpointExplicit: opts.endpointExplicit,
      endpointSource: opts.endpointSource,
      ...(token !== undefined ? { token } : {}),
    });

  return {
    async requestOtp(email) {
      await clientFor().call({
        method: "POST",
        path: "/api/auth/otp/request",
        body: { email },
        schema: otpRequestResponseSchema,
        authenticated: false,
      });
    },

    async verifyOtp(email, code) {
      const result = await clientFor().call({
        method: "POST",
        path: "/api/auth/otp/verify",
        body: { email, code },
        schema: otpVerifyResponseSchema,
        authenticated: false,
      });
      // The cloud's verify response carries identity + session but NOT the
      // email (account-enumeration sensitive); the email the user entered is
      // re-attached by AuthService.completeLogin.
      return { userId: result.user_id, token: result.session.access_token };
    },

    async fetchIdentity(token) {
      const identity = await clientFor(token).call({
        method: "GET",
        path: "/api/auth/whoami",
        schema: identityResponseSchema,
      });
      return { userId: identity.user_id, email: identity.primary_email };
    },
  };
}

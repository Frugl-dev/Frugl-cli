# Feature Specification: CLI-to-Web Session Handoff

**Feature Branch**: `027-cli-web-session-handoff`

**Created**: 2026-06-06

**Status**: Draft

**Input**: User description: "CLI-to-web session handoff via one-time code: after a successful upload, the CLI requests a single-use, short-lived (~60s) handoff code from the cloud (new authenticated endpoint, e.g. POST /api/auth/handoff, using the CLI's existing bearer token) and appends it to the dashboard URL it prints (e.g. ?handoff=<code>). When the user opens the link, the web app exchanges the code for a browser session (Supabase session cookie) and redirects to the clean dashboard URL, so the user is not asked to log in again. If the code is expired or already used, the web login wall preserves the deep link and returns the user to the intended dashboard page after login. CLI must degrade gracefully (print plain dashboard URL) if the handoff endpoint is unavailable, and offer an opt-out flag for shared terminals/CI where embedding a code in printed output is undesirable."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Open dashboard without logging in again (Priority: P1)

A user who is already logged in to the CLI completes an upload. The CLI prints a dashboard link that carries a one-time handoff code. The user clicks the link within its validity window and lands directly on the dashboard page for their upload, already signed in to the web app as the same account — no email entry, no verification code, no login screen.

**Why this priority**: This is the entire point of the feature. The current flow forces a second login immediately after the user has already proven their identity to the CLI, which is the friction being removed.

**Independent Test**: Log in via the CLI, run an upload, open the printed link in a fresh browser profile (no existing web session) within the validity window, and confirm the dashboard for that upload renders with the user signed in as the CLI account.

**Acceptance Scenarios**:

1. **Given** a CLI session with valid credentials and a successful upload, **When** the CLI prints the dashboard link, **Then** the link includes a one-time handoff code tied to the CLI user and the uploaded manifest's dashboard page.
2. **Given** a printed dashboard link with a valid handoff code, **When** the user opens it in a browser with no active web session, **Then** the web app signs the user in as the CLI account and shows the intended dashboard page without prompting for credentials.
3. **Given** the handoff exchange succeeds, **When** the browser lands on the dashboard, **Then** the address bar shows a clean URL with the handoff code removed.
4. **Given** a handoff code that has already been used once, **When** the same link is opened again, **Then** the code is rejected and the user is treated as in User Story 2 (login wall with deep link preserved).

---

### User Story 2 - Expired or used link still gets you to the right place (Priority: P2)

A user opens the printed dashboard link after the handoff code has expired (e.g., the next morning) or after it has already been consumed. They see the normal web login. After completing login, they are taken directly to the dashboard page the link pointed at — the deep link is not lost.

**Why this priority**: Handoff codes are deliberately short-lived, so the expired-link path is a routine experience, not a rare error. Without deep-link preservation the feature would make stale links _worse_ than today.

**Independent Test**: Generate a dashboard link via upload, wait past the validity window (or open it twice), open the link, complete the web login, and confirm the browser lands on the upload's dashboard page.

**Acceptance Scenarios**:

1. **Given** a dashboard link whose handoff code has expired, **When** the user opens it, **Then** the web app shows its login flow without surfacing a confusing error, and after successful login redirects the user to the dashboard page from the original link.
2. **Given** a dashboard link whose handoff code was already redeemed, **When** the user opens it, **Then** behavior is identical to the expired case.
3. **Given** an invalid or tampered handoff code, **When** the user opens the link, **Then** the code is rejected, no session is created from it, and the user falls through to the login flow with the deep link preserved.

---

### User Story 3 - Graceful degradation when handoff cannot be issued (Priority: P2)

A user runs an upload while the handoff capability is unavailable (service error, older cloud version, network hiccup after upload completes). The upload still succeeds and the CLI prints the plain dashboard URL exactly as it does today.

**Why this priority**: Uploads are the core workflow; a convenience feature must never fail, delay, or add noise to a successful upload.

**Independent Test**: Simulate a failing handoff issuance (e.g., service returns an error) and confirm the upload completes successfully with the plain dashboard URL printed and no scary error output.

**Acceptance Scenarios**:

1. **Given** a successful upload and a handoff issuance failure, **When** the CLI prints its summary, **Then** the upload is reported as successful and the dashboard link is printed without a handoff code.
2. **Given** a handoff issuance failure, **When** the CLI reports results, **Then** the failure does not change the upload's exit status and is at most mentioned as informational/debug output.

---

### User Story 4 - Opt out on shared terminals and CI (Priority: P3)

A user running the CLI in CI or on a shared/recorded terminal opts out of handoff codes so that printed output never contains credential material, however short-lived. The CLI prints the plain dashboard URL.

**Why this priority**: Important for security-conscious environments, but a narrower audience than the default interactive flow.

**Independent Test**: Run an upload with the opt-out flag set and confirm the printed dashboard URL contains no handoff code and no handoff issuance request is made.

**Acceptance Scenarios**:

1. **Given** the opt-out flag is provided, **When** an upload completes, **Then** the CLI does not request a handoff code and prints the plain dashboard URL.
2. **Given** the CLI runs in non-interactive mode (machine-readable output), **When** an upload completes, **Then** no handoff code is requested or emitted unless handoff is explicitly requested.

---

### Edge Cases

- Browser already has an active web session for the **same** user: the code is redeemed or discarded and the user lands on the dashboard page signed in; no duplicate-login prompt.
- Browser already has an active web session for a **different** user: the existing session is not silently replaced; the user is informed and can choose which account to continue with (default: keep the existing browser session and ignore the code).
- The user copies the link and shares it: the code is single-use and expires within its short validity window, limiting exposure; a redeemed or expired code never grants access.
- Handoff issuance is slow: issuance must not add noticeable delay to the upload summary; the CLI bounds the wait and falls back to the plain URL.
- Multiple uploads in one CLI invocation: each printed dashboard link is independently usable; at minimum the final/primary link carries a code.
- The handoff code grants exactly one browser sign-in for the CLI user; it is not the CLI's stored credential and its leakage never exposes the CLI token.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: After a successful upload by an authenticated CLI user, the system MUST be able to issue a handoff code bound to that user and to the upload's dashboard destination.
- **FR-002**: A handoff code MUST be single-use: the first successful redemption invalidates it permanently.
- **FR-003**: A handoff code MUST expire within a short validity window (default 60 seconds from issuance) if unredeemed.
- **FR-004**: Issuing a handoff code MUST require the CLI's existing authenticated session; unauthenticated requests MUST be rejected.
- **FR-005**: The CLI MUST append the handoff code to the dashboard URL it prints after a successful upload, in both human-readable and machine-readable output, except when opted out (FR-010, FR-011).
- **FR-006**: When a valid handoff code is redeemed in the browser, the web app MUST establish a signed-in session for the code's user and then display the intended dashboard page at a clean URL with the code removed.
- **FR-007**: When a handoff code is expired, already redeemed, or invalid, the web app MUST NOT create a session from it, MUST fall back to the standard login flow, and MUST return the user to the originally requested dashboard page after successful login.
- **FR-008**: Handoff issuance failure (service error, unsupported server, timeout) MUST NOT fail, delay beyond a bounded wait, or change the exit status of an otherwise successful upload; the CLI MUST print the plain dashboard URL in that case.
- **FR-009**: The handoff code MUST be distinct from the CLI's stored credential; possession of a handoff code MUST NOT reveal or extend the CLI token, and possession of an expired/redeemed code MUST grant nothing.
- **FR-010**: The CLI MUST provide an explicit opt-out (per-invocation flag) that suppresses handoff issuance entirely and prints the plain dashboard URL.
- **FR-011**: In non-interactive/CI contexts the CLI MUST default to not embedding handoff codes in output, with an explicit way to opt in.
- **FR-012**: Redemption of a handoff code MUST be observable for audit (issued, redeemed, expired-unredeemed), consistent with the platform's existing audit expectations.

### Key Entities

- **Handoff Code**: A single-use, short-lived opaque credential issued to an authenticated CLI user. Attributes: associated user, target dashboard destination, issuance time, expiry time, redemption state. Never equal to or derivable from the CLI's stored credential.
- **Dashboard Link**: The URL printed by the CLI after upload. May carry a handoff code as a query parameter; remains a valid plain deep link once the code is stripped, expired, or absent.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A logged-in CLI user who opens the printed link within its validity window reaches their upload's dashboard page signed in, with zero credential prompts and no manual steps beyond the single click.
- **SC-002**: 100% of handoff codes become unusable after first redemption or expiry; a replayed or expired code never yields a session.
- **SC-003**: Upload success rate and reported upload outcome are unchanged by handoff availability: 0 uploads fail or change exit status due to handoff issuance problems.
- **SC-004**: Users who open a stale link reach the originally intended dashboard page after logging in, in 100% of cases (deep link never dropped).
- **SC-005**: Handoff issuance adds no perceptible delay to the upload summary (bounded wait; summary still prints promptly when issuance is slow or down).

## Assumptions

- The web app and cloud service are delivered in a separate repository; this feature spans both. This spec defines the full user-facing behavior, but the CLI-side scope here is: requesting the code after upload completion, appending it to the printed URL, opt-out handling, and graceful fallback. Issuance, redemption, session creation, and deep-link preservation are cloud/web obligations tracked against this same spec.
- The default validity window is 60 seconds; the exact value may be tuned by the cloud without CLI changes.
- The CLI's existing authentication (logged-in session established via email verification) is reused as the authorization for issuing a handoff code; no new login method is introduced.
- Handoff applies to the post-upload dashboard link only in this version; other CLI-printed links (e.g., generic dashboard home) are out of scope.
- An existing signed-in browser session for the same user is an acceptable substitute for redemption; the user must still land on the intended page.
- "Non-interactive" detection follows the CLI's existing conventions for machine-readable output and CI environments.

# security.md

## 1. Core Security Goals

-   Protect public forms from spam/bots.
-   Ensure payment confirmation cannot be spoofed.
-   Ensure manage/confirm links cannot be guessed or modified.
-   Keep all secrets server-side.
-   Ensure admin-only actions are authenticated and authorized.

------------------------------------------------------------------------

## 2. CAPTCHA / Anti-Bot Enforcement

-   Use **Cloudflare Turnstile** (or reCAPTCHA equivalent).
-   Required on **all public POST endpoints**:
    -   bookings pay-now
    -   bookings pay-later
    -   events register
    -   contact form (if present)

Server-side verification required: - Verify token with Turnstile API. -
Reject requests if verification fails.

------------------------------------------------------------------------

## 3. Token Strategy (Confirm + Manage Links)

### 3.1 Types of Tokens

-   **Confirm token**: short-lived, used to confirm email for pay-later
    bookings and free events.
-   **Manage token**: long-lived, used to reschedule/cancel without user
    login.

### 3.2 Storage

-   Confirm links are represented in booking events (event payload), not
    booking table columns.
-   Manage links are deterministic (`m1.<booking_id>`) and validated by
    booking ID lookup plus lifecycle checks.
-   Never log full raw confirm/manage tokens.

### 3.3 Expiration

-   Free event confirm: 15 minutes.
-   Pay-later booking confirm: configured window (default 60 minutes
    unless changed).
-   Manage tokens may remain valid until booking/event date passes.

### 3.4 Validation

-   Confirm token: hash incoming token and match against
    `booking_events.payload.confirm_token_hash`.
-   Manage token: validate token format and booking existence.
-   If no match → 404/401 (do not reveal if the record exists).

------------------------------------------------------------------------

## 4. Stripe Webhook Security

-   Verify Stripe webhook signature using Stripe signing secret.
-   Reject any webhook without valid signature.
-   Webhook handler must be **idempotent**:
    -   Use `stripe_checkout_session_id` as unique key
    -   If already processed → return 200 OK without duplicating actions

------------------------------------------------------------------------

## 5. Rate Limiting Strategy

Recommended minimum: - Rate-limit by IP + endpoint. - Apply stricter
limits on: - booking creation - event registration - contact form
submission

Cloudflare options: - Use Cloudflare WAF/rate limiting rules (if
enabled). - Or implement in Worker with a lightweight KV/DO counter
(Phase I acceptable).

------------------------------------------------------------------------

## 6. Secrets Management

-   All secrets stored as environment variables:
    -   Stripe secret keys + webhook signing secret
    -   Turnstile secret
    -   Google OAuth client secret + refresh token
    -   Supabase service role key
    -   Job token secret for internal endpoints
-   Never ship secrets to client.
-   Separate dev and prod secrets.

------------------------------------------------------------------------

## 7. Admin Auth Strategy (Phase II)

-   Use Supabase Auth.
-   Single-admin account initially (email-based).
-   Admin endpoints must check:
    -   valid session JWT
    -   role/allowlist (admin email) before mutating state

Admin endpoints include: - create/update events - upload/reorder media -
notes and client-data edits - late-access link management

------------------------------------------------------------------------

## 8. Logging & Incident Basics

-   Log all webhook failures, calendar failures, and email send
    failures. Failures shoud also be logged in a dedicated db table.
-   Log job runs with counts (processed, sent, skipped).
-   Do not log full tokens or secrets.

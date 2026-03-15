# ILLUMINATE Technical Companion

## Table of Contents

- [1. Scope](#1-scope)
- [2. Canonical Artifacts](#2-canonical-artifacts)
- [3. Runtime Topology](#3-runtime-topology)
- [4. Frontend Stack and Conventions](#4-frontend-stack-and-conventions)
- [5. Backend Booking Worker](#5-backend-booking-worker)
- [6. Schema and Data Model References](#6-schema-and-data-model-references)
- [7. Provider and Integration Boundaries](#7-provider-and-integration-boundaries)
- [8. Deployment Model](#8-deployment-model)
- [9. Environment Variables and Bindings](#9-environment-variables-and-bindings)
- [10. Coding Conventions](#10-coding-conventions)
- [11. CSS and UI Conventions](#11-css-and-ui-conventions)
- [12. Automated Test Conventions](#12-automated-test-conventions)
- [13. Operational Notes](#13-operational-notes)
- [14. Glossary](#14-glossary)

## 1. Scope

This companion covers the technical shape of the ILLUMINATE website, booking system, and admin tooling.

Included:

- `apps/site`
- `apps/admin`
- `apps/api-booking`
- shared booking-related schema, provider, deployment, and test conventions

Excluded:

- `apps/pa`
- `apps/api-pa`
- PA-only env vars and deployment details

## 2. Canonical Artifacts

Primary references for this scope:

- requirements: [requirements.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/requirements.md)
- user-facing acceptance: [expected_user_scenarios_freeze_illuminate_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/expected_user_scenarios_freeze_illuminate_2026-03-15.md)
- pay-later refinement: [pay_later_refined_flow_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/pay_later_refined_flow_2026-03-15.md)
- live schema snapshot: [public_schema_snapshot_2026-03-15.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/public_schema_snapshot_2026-03-15.sql)
- editor-ready DDL companion: [public_schema_editor_ddl_2026-03-15.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/public_schema_editor_ddl_2026-03-15.sql)
- manual testing companion: [manual_testing_companion.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/manual_testing_companion.md)
- E2E UI matrix: [e2e_ui_test_matrix.xlsx](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/e2e_ui_test_matrix.xlsx)

Interpretation rule:

- the full schema snapshot is the literal remote Supabase `public` dump
- the shorter DDL companion is the authored/editor-oriented reference, intentionally normalized to `text + CHECK` for value sets instead of authored enum/type dependencies

## 3. Runtime Topology

### 3.1 Public site

- hosted as a static frontend on Cloudflare Pages
- runtime is plain browser HTML/CSS/JavaScript
- talks to the booking worker under `/api/*`

### 3.2 Admin site

- hosted as a static frontend on Cloudflare Pages
- runtime is plain browser HTML/CSS/JavaScript
- talks to the same booking worker under `/api/admin/*`

### 3.3 Booking backend

- implemented as a Cloudflare Worker in `apps/api-booking`
- serves both public website APIs and organizer/admin APIs
- owns cron-triggered booking sweeps
- owns payment webhook handling

### 3.4 Shared operational model

- business truth stays in booking-domain tables
- technical observability stays in `api_logs` and `exception_logs`
- external integrations are isolated behind provider interfaces

## 4. Frontend Stack and Conventions

### 4.1 Public site stack

- static HTML pages
- vanilla JavaScript files in `apps/site/js`
- page scripts under `apps/site/js/pages`
- page-specific CSS files under `apps/site/css`
- no SPA framework
- no React/Vue/Svelte runtime

### 4.2 Admin site stack

- static HTML pages
- vanilla JavaScript files in `apps/admin/js`
- page scripts under `apps/admin/js/pages`
- no SPA framework

### 4.3 Frontend API-base conventions

Public site:

- prefers `localStorage.API_BASE`
- then `window.ENV.VITE_API_BASE`
- then localhost default in local dev
- then `https://api.letsilluminate.co`

Admin site:

- treats `VITE_API_BASE` as the root host
- appends `/api`
- keeps localhost overrides local-only
- strips stale production overrides on non-localhost domains

### 4.4 Frontend coding style

- plain functions and IIFEs
- DOM-first rendering
- page-local state objects rather than framework stores
- `siteClient` / `adminClient` request wrappers instead of ad hoc fetch duplication
- explicit post-submit recovery pages (`confirm`, `payment-success`, `continue-payment`, `manage`)

## 5. Backend Booking Worker

### 5.1 Worker ownership

The booking worker owns:

- public content/config endpoints
- session slots
- session booking creation
- event booking creation
- confirmation links
- payment recovery routes
- manage/reschedule/cancel routes
- contact capture
- organizer/admin routes
- dev/test inspection routes for captured emails and booking artifacts
- Stripe webhook
- cron job triggers

### 5.2 Public route families

- `GET /api/session-types`
- `GET /api/events`
- `GET /api/config`
- `GET /api/slots`
- `POST /api/bookings/pay-now`
- `POST /api/bookings/pay-later`
- `GET /api/bookings/confirm`
- `GET /api/bookings/continue-payment`
- `GET /api/bookings/payment-status`
- `GET /api/bookings/manage`
- `POST /api/bookings/reschedule`
- `POST /api/bookings/cancel`
- `POST /api/events/:slug/book`
- `POST /api/events/:slug/book-with-access`
- `POST /api/events/reminder-subscriptions`
- `POST /api/contact`

### 5.3 Admin route families

- `GET /api/admin/bookings`
- `PATCH|POST /api/admin/bookings/:bookingId`
- `POST /api/admin/bookings/:bookingId/payment-settled`
- `POST /api/admin/bookings/:bookingId/manage-link`
- `POST /api/admin/bookings/:bookingId/client-manage-link`
- `GET /api/admin/events`
- `GET /api/admin/events/all`
- `PATCH /api/admin/events/:eventId`
- `POST /api/admin/events/:eventId/late-access-links`
- `GET /api/admin/contact-messages`
- `GET|PATCH|POST /api/admin/config`
- `GET|POST|PATCH /api/admin/session-types`
- `POST /api/admin/upload-image`

### 5.4 Core booking architecture

The booking domain is centered on:

- `bookings`
- `payments`
- `booking_events`
- `booking_side_effects`
- `booking_side_effect_attempts`

Meaning:

- `bookings` = current booking reality
- `payments` = current payment reality
- `booking_events` = business facts that happened
- `booking_side_effects` = queued work to perform
- `booking_side_effect_attempts` = retry/execution trail for that work

### 5.5 Pay-later technical summary

Current intended pay-later architecture:

- submit creates only the pending booking + confirmation request
- email confirmation changes booking to `CONFIRMED`
- payment row is created after confirmation
- Stripe invoice bootstrap is attempted synchronously after confirmation
- invoice bootstrap failure is non-fatal
- `continue-payment` can rebuild Stripe state if the first bootstrap failed

## 6. Schema and Data Model References

### 6.1 Live references

- full remote snapshot: [public_schema_snapshot_2026-03-15.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/public_schema_snapshot_2026-03-15.sql)
- shorter editor DDL: [public_schema_editor_ddl_2026-03-15.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/public_schema_editor_ddl_2026-03-15.sql)

### 6.2 Booking-domain tables in scope

- `clients`
- `session_types`
- `events`
- `bookings`
- `payments`
- `booking_events`
- `booking_side_effects`
- `booking_side_effect_attempts`
- `event_late_access_links`
- `event_reminder_subscriptions`
- `contact_messages`
- `coupons`
- `system_settings`
- `api_logs`
- `exception_logs`

### 6.3 Value-set convention

Authored schema and companion docs should use:

- plain text columns
- explicit `CHECK` constraints for allowed values

Do not treat authored Postgres enums as the preferred long-term convention for this scope, even if the literal live remote dump still contains them.

## 7. Provider and Integration Boundaries

### 7.1 Supabase / Postgres

Purpose:

- primary persistence for booking/admin data

Operational mode:

- `REPOSITORY_MODE=supabase` in the live booking worker
- `REPOSITORY_MODE=mock` for focused local/mock runs

### 7.2 Resend / email

Purpose:

- confirmation-request emails
- booking confirmation emails
- payment reminder emails
- expiration and cancellation emails
- contact notification delivery

Modes:

- `mock`
- `resend`

Mode behavior:

- `resend` sends the built provider payload to Resend
- `mock` reuses the same payload builders as the Resend path and captures the exact provider-bound payload instead of generating a separate simplified mock body

Captured payload contract in `mock` mode:

- stored fields include `from`, `replyTo`, `subject`, `text`, and `html`
- backend tests should assert against those captured payload fields and links directly
- browser preview should render the captured `html` as-is, not a fake reconstructed email body

Developer/testing routes when email is captured:

- `GET /api/__dev/emails`
- `GET /api/__dev/emails/:emailId`
- `GET /api/__dev/emails/:emailId/html`

Developer/testing preview surface:

- `apps/site/dev-emails.html`
- the page lists captured emails
- the preview pane loads `preview_html_url` into an iframe
- the iframe therefore shows the real captured email HTML, including the real CTA links/buttons

Availability rule:

- these preview routes exist only when email delivery is captured
- if `EMAIL_MODE=resend`, the preview endpoints are intentionally unavailable because the worker is sending to the real provider instead of storing the payload locally

### 7.3 Stripe / payments

Purpose:

- checkout sessions
- pay-later invoice creation
- payment success/failure recovery
- webhook finalization

Modes:

- `mock`
- `stripe`

Main objects used:

- checkout sessions
- payment intents
- invoices
- webhook events

### 7.4 Google Calendar

Purpose:

- availability reads for slot generation
- create/update/delete booking events on the real calendar

Modes:

- `mock`
- `google`

Important split-auth rule:

- availability reads use service-account credentials
- booking writes use OAuth refresh-token credentials

### 7.5 Turnstile

Purpose:

- anti-bot protection for public submissions

Modes:

- `mock`
- `turnstile`

### 7.6 Cloudflare Access

Purpose:

- organizer/admin sign-in gate

Implementation note:

- the codebase supports real Access enforcement
- `ADMIN_AUTH_DISABLED=true` is a temporary environment bypass, not the intended production baseline

### 7.7 R2 + Google Drive

Purpose:

- image upload and public asset serving
- optional Google Drive backup/reference metadata

## 8. Deployment Model

### 8.1 Domains

- public site: `letsilluminate.co`
- admin site: `admin.letsilluminate.co`
- booking API worker: `api.letsilluminate.co` and `letsilluminate.co/api/*`

### 8.2 Worker deployment

`apps/api-booking/wrangler.toml` defines:

- Worker entrypoint
- routes
- cron trigger
- provider-mode defaults
- R2 image bucket binding

### 8.3 Cron

Configured schedule:

- `* * * * *`

Unified cron responsibilities:

- checkout expiry follow-up
- unconfirmed booking expiry checks
- overdue unpaid booking expiry checks
- payment reminder checks
- event reminder checks
- side-effect dispatch
- calendar sync retry

### 8.4 Frontend deployment

- `apps/site` and `apps/admin` are static Pages deployments
- runtime configuration is either injected via small env shims or handled through code defaults

## 9. Environment Variables and Bindings

The table below is scoped to website + booking + admin only.

| Name | Surface | Kind | Possible values or source | Meaning |
| --- | --- | --- | --- | --- |
| `REPOSITORY_MODE` | booking worker | plain var | `mock`, `supabase` | Selects mock repository vs real Supabase persistence. |
| `EMAIL_MODE` | booking worker | plain var | `mock`, `resend` | Selects mock email provider vs live Resend delivery. |
| `CALENDAR_MODE` | booking worker | plain var | `mock`, `google` | Selects mock calendar vs Google Calendar integration. |
| `PAYMENTS_MODE` | booking worker | plain var | `mock`, `stripe` | Selects mock payments vs Stripe-backed checkout/invoice behavior. |
| `ANTIBOT_MODE` | booking worker | plain var | `mock`, `turnstile` | Selects mock antibot behavior vs Turnstile validation. |
| `SITE_URL` | booking worker | plain var | public site base URL for the environment | Used to generate public links for confirm/manage/payment flows. |
| `SESSION_ADDRESS` | booking worker | plain var | venue or meeting address text | Displayed in booking details and emails for session bookings. |
| `SESSION_MAPS_URL` | booking worker | plain var | Google Maps or equivalent URL | Map link for session bookings. |
| `API_ALLOWED_ORIGINS` | booking worker | plain var | comma-separated allowed origins | CORS allowlist for public/admin frontend origins. |
| `ADMIN_ALLOWED_EMAILS` | booking worker | secret/plain var | comma-separated email allowlist | Restricts admin access to specific Cloudflare Access identities. |
| `ADMIN_DEV_EMAIL` | booking worker | secret/plain var | one development email | Local/dev fallback identity for admin workflows. |
| `ADMIN_AUTH_DISABLED` | booking worker | plain var | `true` or `false`-like strings | Temporary auth bypass flag; intended only for controlled environments. |
| `CLOUDFLARE_ACCESS_AUD` | booking worker | secret/plain var | Cloudflare Access application audience id | Used to validate Access JWTs for organizer/admin auth. |
| `SUPABASE_URL` | booking worker | secret | issued by Supabase project settings | Base URL for the Supabase project used by booking/admin persistence. |
| `SUPABASE_SECRET_KEY` | booking worker | secret | issued by Supabase project settings | Server-only Supabase key used by the repository layer. |
| `OBSERVABILITY_SCHEMA` | booking worker | plain var | schema name, current default `public` | Chooses which DB schema the observability wrapper writes to. |
| `RESEND_API_KEY` | booking worker | secret | issued by Resend | Live email provider credential. |
| `GOOGLE_CALENDAR_ID` | booking worker | plain var | Google Calendar id | Target calendar id for both availability reads and booking writes. |
| `GOOGLE_CLIENT_CALENDAR` | booking worker | secret | issued by Google Cloud OAuth client | OAuth client id used for booking write operations. |
| `GOOGLE_CLIENT_SECRET_CALENDAR` | booking worker | secret | issued by Google Cloud OAuth client | OAuth client secret used for booking write operations. |
| `GOOGLE_REFRESH_TOKEN_CALENDAR` | booking worker | secret | issued from Google OAuth consent flow | Refresh token used to mint write-capable Google access tokens. |
| `GOOGLE_CLIENT_EMAIL` | booking worker | secret/plain var | Google service account email | Service account identity for availability reads and optional Drive backup. |
| `GOOGLE_PRIVATE_KEY` | booking worker | secret | Google service account private key | Private key paired with the service account for JWT-based access tokens. |
| `GOOGLE_TOKEN_URI` | booking worker | plain var | usually `https://oauth2.googleapis.com/token` | Token endpoint for Google auth exchanges. |
| `TIMEZONE` | booking worker | plain var | IANA timezone, current `Europe/Zurich` | Default timezone for slot generation and date calculations. |
| `STRIPE_SECRET_KEY` | booking worker | secret | issued by Stripe | Server-side Stripe API key. |
| `STRIPE_WEBHOOK_SECRET` | booking worker | secret | issued by Stripe webhook endpoint config | Verifies Stripe webhook signatures. |
| `STRIPE_PUBLISHABLE_KEY` | booking worker | plain/secret var | issued by Stripe | Reserved for public-side Stripe compatibility where needed. |
| `TURNSTILE_SECRET_KEY` | booking worker | secret | issued by Cloudflare Turnstile | Live Turnstile verification secret. |
| `TURNSTILE_SITE_KEY` | booking worker | plain/secret var | issued by Cloudflare Turnstile | Live site key exposed via `/api/config` when Turnstile is enabled. |
| `TURNSTILE_TEST_SITE_KEY_PASS` | booking worker | plain var | Cloudflare documented test key | Forces successful Turnstile behavior in controlled environments. |
| `TURNSTILE_TEST_SITE_KEY_ALWAYS_FAIL` | booking worker | plain var | Cloudflare documented test key | Forces failed Turnstile behavior in controlled environments. |
| `TURNSTILE_TEST_SECRET_KEY_PASS` | booking worker | plain var | Cloudflare documented test secret | Companion secret for successful test-site-key behavior. |
| `TURNSTILE_TEST_SECRET_KEY_ALWAYS_FAIL` | booking worker | plain var | Cloudflare documented test secret | Companion secret for always-fail test-site-key behavior. |
| `JOB_SECRET` | booking worker | secret | project-issued bearer token | Protects manual/internal `/api/jobs/:name` calls. |
| `ADMIN_MANAGE_TOKEN_SECRET` | booking worker | secret | project-issued secret | Signs privileged admin manage links. |
| `IMAGE_BASE_URL` | booking worker | plain var | CDN/base URL for booking/admin images | Public base URL used to serve uploaded images. |
| `GOOGLE_DRIVE_FOLDER_ID` | booking worker | secret/plain var | Google Drive folder id | Optional destination/reference folder for Drive-backed image backup. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | booking worker | secret | Google service account JSON blob | Optional combined credential that can replace separate service-account fields. |
| `IMAGES_BUCKET` | booking worker | binding | Cloudflare R2 bucket binding | Stores uploaded images for session types and events. |
| `VITE_API_BASE` | public site | frontend env | base API host, e.g. `https://api.letsilluminate.co` | Optional runtime hint for the public site API base. |
| `VITE_API_BASE` | admin site | frontend env | root API host, e.g. `https://api.letsilluminate.co` | Optional runtime hint for the admin site API base. |

## 10. Coding Conventions

### 10.1 Backend conventions

- TypeScript Cloudflare Worker code
- thin handlers, orchestration in services
- repository/provider interfaces isolate external systems
- shared route wrapper owns top-level error handling and observability
- explicit structured logs around decisions, denies, and provider branches
- consistent JSON error envelopes with CORS preservation
- no authored enum/type dependencies in preferred DDL conventions

### 10.2 Booking-domain conventions

- events describe facts
- side effects describe queued responsibilities
- cron is a wake-up mechanism, not a business source
- payment state and booking state are related but separate
- long-running verification work reuses pending side-effect rows instead of spawning duplicates

### 10.3 Frontend conventions

- plain JS, no component framework
- page-local modules and DOM rendering
- use request wrappers instead of raw fetch sprawl
- favor explicit recovery states over optimistic hidden behavior

### 10.4 Documentation conventions

- live schema snapshot files are dated
- freeze files are dated
- authored companions may use stable filenames when they are intended as the current canonical document
- superseded documents belong in `docs/old/`

## 11. CSS and UI Conventions

### 11.1 Token-first styling

The public site uses CSS custom properties as design tokens.

Minimum conventions already present:

- color tokens
- typography token(s)
- spacing tokens
- radius tokens
- easing and shadow tokens

### 11.2 Current public-site styling language

Observed conventions in `apps/site/css/main.css` and page CSS:

- OKLCH color palette
- dark lake / Lugano visual language
- imported web fonts
- shared layout utility classes such as `.container` and `.section`
- page-specific styles layered on top of a shared base stylesheet
- motion via fades/reveals and animated custom properties

### 11.3 UI rules

- mobile-first layouts
- explicit visual states for status and errors
- accessible forms and validation
- touch-safe buttons
- no hardcoded hex sprawl inside components when tokens already exist

## 12. Automated Test Conventions

### 12.1 Public/admin frontend unit tests

- framework: Vitest
- environment: JSDOM
- locations:
  - `apps/site/tests`
  - `apps/admin/tests`

Use these for:

- page rendering logic
- API-base behavior
- coupon helpers
- turnstile helpers
- admin table/modal behavior

### 12.2 Backend tests

- framework: Vitest
- language: TypeScript
- location: `apps/api-booking/test`

Use these for:

- route behavior
- error envelopes and CORS
- booking orchestration
- captured email payload contract testing
- dev email preview route behavior
- provider wiring
- sweeper behavior
- admin diagnostics

### 12.3 Browser E2E tests

- framework: Playwright
- location: `apps/site/e2e`

Current suite shape:

- navigation smoke
- public booking flows
- dev email preview flow
- public remaining-state coverage
- pay-later and admin interactions
- turnstile UI integration
- slot-contention scenarios
- mobile regression coverage

Execution artifacts:

- spreadsheet execution matrix: [e2e_ui_test_matrix.xlsx](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/e2e_ui_test_matrix.xlsx)
- manual execution companion: [manual_testing_companion.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/manual_testing_companion.md)

### 12.4 Test-writing policy

- prefer lean, high-signal tests
- write tests around user-visible outcomes and critical business rules
- keep provider mocks explicit
- verify diagnostic paths on important backend failures
- when email is mocked, assert against the captured production payload rather than a custom fake rendering
- for browser preview coverage, inspect the real iframe-rendered email HTML and CTA links
- use scenario ids in manual/E2E planning so docs and tests map cleanly
- mark automation gaps explicitly when the suite still lags behind the latest source-of-truth behavior

## 13. Operational Notes

- the booking worker currently runs a unified minute cron
- the live schema snapshot must be refreshed from Supabase when schema docs are updated
- the shorter DDL companion is for editor use and documentation, not a promise that the literal live DB dump is already normalized the same way
- captured email preview depends on `EMAIL_MODE=mock`; it is not a mirror of Resend inbox state
- deterministic browser email-preview setup also benefits from `ANTIBOT_MODE=mock` so the booking flow can create a captured email without extra anti-bot variability
- the browser preview Playwright spec is ready, but live end-to-end verification should be rerun after deploying the latest worker/site fixes to the target environment
- some older automated tests may lag behind the March 15, 2026 pay-later refinement; the pay-later refinement doc overrides those stale expectations

## 14. Glossary

- **Admin manage link**: A privileged manage URL that includes both the public manage token and an admin override token.
- **API base**: The resolved host/root that frontend code uses when building `/api/*` requests.
- **Antibot mode**: The selected provider mode for public submission verification, usually `mock` or `turnstile`.
- **Booking event**: A business fact that happened, such as form submission, cancellation, expiration, or payment settlement.
- **Booking side effect**: Queued work triggered by a booking event, such as sending email, reserving a calendar slot, or verifying a deadline.
- **Booking side-effect attempt**: The execution record for one side effect run or retry.
- **Checkout session**: The payment-provider object used for pay-now flows and some continue-payment fallbacks.
- **Cloudflare Access**: The identity/access gate used for organizer/admin sign-in.
- **Captured email**: The exact provider-bound email payload stored locally in `mock` mode instead of being sent to Resend.
- **Confirmation link**: The tokenized public URL used to confirm pending free or pay-later bookings.
- **Continue-payment**: The public recovery path that either redirects into an existing payment URL or bootstraps one if needed.
- **Correlation id**: The operation-level identifier used to trace one business operation across logs and provider calls.
- **Dev email preview**: The developer surface made of `/api/__dev/emails*` plus `dev-emails.html`, used to inspect captured email payloads and render their real HTML in-browser.
- **Editor-ready DDL companion**: The shorter schema script intended for human/editor use, normalized away from authored enum/type dependencies.
- **Event late-access link**: A tokenized organizer-generated URL that temporarily reopens a closed event for registration.
- **Manage link**: The tokenized public URL that lets a client inspect and, when allowed, reschedule or cancel a booking.
- **Observability schema**: The DB schema where technical observability tables are written.
- **Pay later**: A booking mode where email confirmation confirms the booking first and payment initiation begins after that confirmation.
- **Provider mode**: The runtime switch that chooses mock vs live infrastructure for repository, email, calendar, payments, or antibot.
- **Public booking policy**: The timing and self-service configuration loaded from `system_settings` and exposed where needed to frontend/runtime code.
- **RLS**: Row-level security settings applied on database tables.
- **Slot lead time**: The minimum future notice required before a slot can be offered publicly.
- **Technical observability**: The logging model centered on `api_logs` and `exception_logs`, separate from booking business truth.

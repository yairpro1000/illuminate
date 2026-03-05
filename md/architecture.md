# architecture.md

## 1. High-Level Architecture

Frontend: Cloudflare Pages (static)\
API Layer: Cloudflare Workers\
Database: Supabase (Postgres)\
Payments: Stripe\
Calendar: Google Calendar API\
Email: Transactional email provider\
Anti-bot: Turnstile

------------------------------------------------------------------------

## 2. Responsibility Separation

Stripe → payment state authority\
Supabase → booking & registration lifecycle state\
Google Calendar → schedule truth\
Email provider → notification delivery

------------------------------------------------------------------------

## 3. Data Flow Overview

User → Frontend → API → DB\
Payment → Stripe Checkout → Webhook → API → DB\
Confirmed booking → API → Google Calendar\
Jobs → Scheduler → Internal API endpoints

------------------------------------------------------------------------

## 4. Environment Strategy

-   Separate dev & prod environments.
-   Separate Stripe test/live keys.
-   Separate Supabase projects.
-   Environment variables injected at runtime.

------------------------------------------------------------------------

## 5. Security Model

-   All public POST endpoints require Turnstile token.
-   Token hashing for confirm/manage links.
-   Stripe webhook signature verification.
-   No secrets exposed client-side.
-   Admin auth via Supabase.

### PA (Personal Assistant) app security + data access

-   PA UI is served from Cloudflare Pages and is protected by Cloudflare Access.
-   PA API runs in a Cloudflare Worker and is protected by Cloudflare Access (same-origin `/pa/*` routes).
-   Only the Worker talks to Supabase using `SUPABASE_SECRET_KEY` (server-only).
-   The PA frontend does **not** use a Supabase publishable/browser key in this architecture.

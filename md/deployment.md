# deployment.md

## 1. Cloudflare Setup Steps

### 1.1 Pages (Frontend)

-   Create Cloudflare Pages project connected to Git repo.
-   Build command depends on frontend stack (or none if pure static).
-   Deploy to `https://<project>.pages.dev`.

### 1.2 Workers (API)

-   Create a Cloudflare Worker for `/api/*` + `/internal/*` endpoints.
-   Configure routes:
    -   `/api/*`
    -   `/internal/*`
    -   `/api/stripe/webhook`

### 1.3 Scheduled Triggers (Optional Runtime Scheduler)

Even though jobs are scheduler-agnostic, Cloudflare Cron Triggers can
call: - `/internal/jobs/expire-checkout-holds` -
`/internal/jobs/send-followups` -
`/internal/jobs/send-payment-due-reminders` -
`/internal/jobs/cancel-overdue-unpaid-bookings` -
`/internal/jobs/send-reminders-24h`

------------------------------------------------------------------------

## 2. Supabase Setup Steps

-   Create Supabase project (dev + prod recommended).
-   Run schema from `database_schema.md`.
-   Configure Row Level Security (RLS) as needed:
    -   Public access via server only (recommended).
-   Create admin user (Phase II).

------------------------------------------------------------------------

## 3. Environment Variables List (Minimum)

### Stripe

-   STRIPE_SECRET_KEY
-   STRIPE_WEBHOOK_SECRET
-   STRIPE_PRICE_ID\_\* (if using fixed prices)
-   STRIPE_SUCCESS_URL
-   STRIPE_CANCEL_URL

### Supabase

-   SUPABASE_URL
-   SUPABASE_ANON_KEY (frontend only if needed)
-   SUPABASE_SERVICE_ROLE_KEY (server-only)

### Google Calendar

-   GOOGLE_CLIENT_ID
-   GOOGLE_CLIENT_SECRET
-   GOOGLE_REFRESH_TOKEN
-   GOOGLE_CALENDAR_ID

### Email

-   EMAIL_PROVIDER_API_KEY
-   EMAIL_FROM_ADDRESS

### Anti-bot

-   TURNSTILE_SECRET_KEY
-   TURNSTILE_SITE_KEY (frontend)

### Internal Jobs

-   JOB_TOKEN_SECRET

------------------------------------------------------------------------

## 4. Webhook Configuration

-   In Stripe dashboard, set webhook URL to:
    -   `https://<your-domain>/api/stripe/webhook`
-   Subscribe to:
    -   `checkout.session.completed`
    -   (optional) `payment_intent.*` events

------------------------------------------------------------------------

## 5. Production Checklist

-   Domain connected + HTTPS verified
-   SPF/DKIM/DMARC configured for email sending domain
-   Stripe live mode enabled and verified
-   Turnstile keys set for production domain
-   Google OAuth set to production redirect URIs
-   Internal job endpoints protected with secret header
-   Logs/monitoring enabled

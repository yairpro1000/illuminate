# Deployment

## Domains

- Public booking frontend: `letsilluminate.co`
- Admin frontend: `admin.letsilluminate.co`
- PA frontend: `pa.letsilluminate.co`

## Worker Ownership

### `apps/api-booking`

Deploy this worker to:

- `letsilluminate.co/api/*`
- `admin.letsilluminate.co/api/*`

It owns:

- public booking/session/event/contact APIs
- organizer/admin booking APIs
- `/api/stripe/webhook`
- `/api/jobs/:name`

Cron triggers are source-controlled in [apps/api-booking/wrangler.toml](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/apps/api-booking/wrangler.toml).

Configured schedule:

- `*/5 * * * *`: checkout expiry + calendar sync retries
- `*/15 * * * *`: unconfirmed follow-ups + overdue unpaid cancellations
- `*/30 * * * *`: payment-due reminders
- `0 * * * *`: 24h reminders

### `apps/api-pa`

Deploy this worker only to:

- `pa.letsilluminate.co/api/*`

It owns only PA/backoffice routes. It must not serve public booking or organizer/admin booking endpoints.

## Frontends

- `apps/site`: Cloudflare Pages static deploy
- `apps/admin`: Cloudflare Pages static deploy
- `apps/pa`: Cloudflare Pages/Vite deploy

## Dev-Stage Provider Defaults

`apps/api-booking` now persists to Supabase by default. The remaining provider defaults stay explicit:

- `REPOSITORY_MODE=supabase`
- `PAYMENTS_MODE=mock`
- `ANTIBOT_MODE=mock`

For local `wrangler dev --env local`, email and calendar also remain mocked by default.

## Required Secrets / Vars

### Booking worker

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `JOB_SECRET`
- `ADMIN_ALLOWED_EMAILS` or `ADMIN_DEV_EMAIL` for organizer access
- optional real-provider secrets only if intentionally testing non-mock paths

### PA worker

- `SUPABASE_SECRET_KEY`
- `PA_DEV_EMAIL` for localhost-only Access bypass if needed
- `OPENAI_API_KEY` when using OpenAI-backed PA flows

## Webhook

Stripe webhook target, when enabled later, belongs to the booking worker:

- `https://letsilluminate.co/api/stripe/webhook`

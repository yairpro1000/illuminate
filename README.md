# Monorepo Structure

This repo now uses explicit business-domain app names:

- `apps/site`: public booking frontend at `letsilluminate.co`
- `apps/admin`: organizer/admin frontend at `admin.letsilluminate.co`
- `apps/pa`: PA frontend at `pa.letsilluminate.co`
- `apps/api-booking`: shared booking + organizer/admin API worker
- `apps/api-pa`: PA-only API worker
- `apps/shared`: shared cross-app code such as observability helpers

## API Ownership

`apps/api-booking` owns:

- `letsilluminate.co/api/*`
- `admin.letsilluminate.co/api/*`

Its surface includes:

- public booking/session/event/contact routes
- organizer/admin booking routes
- Stripe webhook
- cron/manual booking jobs
- explicit dev-only mock endpoints under `/api/__dev/*`

`apps/api-pa` owns:

- `pa.letsilluminate.co/api/*`

Its surface is PA-only:

- list management
- parse/translate/commit/undo flows
- PA email/speech helpers
- PA observability ingestion

There is intentionally no second backend serving the public booking or organizer/admin API.

## Dev Stage

The current repo target is coherence and testability, not production hardening.

- Payments are mock-first.
- Anti-bot is mock-first.
- Booking worker provider modes default to mock in `apps/api-booking/wrangler.toml`.
- Real email/calendar integrations may still exist behind explicit provider switches, but they are not the default architecture for this stage.

## Migrations and Docs

- Booking/admin schema migrations: `apps/api-booking/migrations/`
- PA-specific migrations: `apps/api-pa/migrations/`
- Public and admin API contract: `docs/api_contracts.md`
- Deployment ownership: `docs/deployment.md`
- Shared observability schema: `docs/shared_schema.md`

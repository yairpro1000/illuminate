# PA (Cloudflare Pages UI)

This is the deployable PA UI (Vite + React) intended to be served via Cloudflare Pages.

- API is expected at `/api/*` (same origin) by default.
- For local dev, run the Worker API separately and use the Vite proxy in `vite.config.ts`.
- Frontend observability is disabled by default outside localhost. Set `VITE_FRONTEND_OBSERVABILITY_ENABLED=true` to enable browser event ingestion to `/api/observability/frontend`.

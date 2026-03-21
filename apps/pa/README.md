# PA (Cloudflare Pages UI)

This is the deployable PA UI (Vite + React) intended to be served via Cloudflare Pages.

- API is expected at `/api/*` (same origin) by default.
- On `*.pages.dev`, the UI now defaults to `https://pa-api.yairpro.workers.dev/api` so preview builds can keep using Cloudflare-hosted paths even when `pa.letsilluminate.co` is unavailable.
- Override the preview API host with `VITE_PA_PREVIEW_API_BASE` if needed.
- For local dev, run the Worker API separately and use the Vite proxy in `vite.config.ts`.
- Frontend observability is disabled by default outside localhost. Set `VITE_FRONTEND_OBSERVABILITY_ENABLED=true` to enable browser event ingestion to `/api/observability/frontend`.

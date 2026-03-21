## API PA Worker

`apps/api-pa` is the PA-only backend.

It owns only `pa.letsilluminate.co/api/*`, including:

- `GET /api/health`
- `POST /api/observability/frontend`
- `GET /api/me`
- `GET /api/config`
- `GET /api/lists`
- `GET /api/lists/:listId/items`
- `POST /api/lists/:listId/reorder`
- `POST /api/parse`
- `POST /api/translate`
- `POST /api/translate/refine`
- `POST /api/commit`
- `GET /api/undo`
- `POST /api/undo`
- `GET /api/export/csv/:listId`
- `GET /api/export/xlsx/:listId`
- `GET /api/export/:listId.csv`
- `GET /api/export/:listId.xlsx`
- `POST /api/email`
- `POST /api/speak`

It does not own public booking routes or organizer/admin booking routes.

Preview support:

- `workers.dev` health/debug URL: `https://pa-api.yairpro.workers.dev/api/health`
- `API_ALLOWED_ORIGINS` can include Pages preview origins such as `https://yairpa.pages.dev`
- `PA_PREVIEW_DEV_EMAIL` allows `*.pages.dev -> *.workers.dev` preview access without Cloudflare Access
- production `pa.letsilluminate.co/api/*` continues to rely on Cloudflare Access headers

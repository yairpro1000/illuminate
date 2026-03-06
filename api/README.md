## API (Cloudflare Worker)

This folder is reserved for the backend API Worker.

Target shape:

- PA (admin-only):
  - `GET /api/health`
  - `GET /api/me`
  - `GET /api/config`
  - `GET /api/lists`
  - `GET /api/lists/:listId/items`
  - `POST /api/lists/:listId/reorder`
  - `POST /api/parse`
  - `POST /api/commit`
  - `GET /api/export/:listId.csv`
  - `GET /api/export/:listId.xlsx`

- Marketing-site ops (future):
  - `POST /booking/create`
  - `POST /stripe/checkout-session`
  - `GET /booking/status`
  - Stripe webhooks

The public site (`apps/site`) and admin (`apps/admin`) should call this API; they should not contain backend deployment config.

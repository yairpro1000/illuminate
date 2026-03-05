## API (Cloudflare Worker)

This folder is reserved for the backend API Worker.

Target shape:

- PA (admin-only):
  - `GET /pa/health`
  - `GET /pa/me`
  - `GET /pa/config`
  - `GET /pa/lists`
  - `GET /pa/lists/:listId/items`
  - `POST /pa/lists/:listId/reorder`
  - `POST /pa/parse`
  - `POST /pa/commit`
  - `GET /pa/export/:listId.csv`
  - `GET /pa/export/:listId.xlsx`

- Marketing-site ops (future):
  - `POST /booking/create`
  - `POST /stripe/checkout-session`
  - `GET /booking/status`
  - Stripe webhooks

The public site (`apps/site`) and admin (`apps/admin`) should call this API; they should not contain backend deployment config.

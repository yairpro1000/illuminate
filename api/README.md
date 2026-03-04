## API (Cloudflare Worker)

This folder is reserved for the backend API Worker.

Target shape:

- `POST /booking/create`
- `POST /stripe/checkout-session`
- `GET /booking/status`
- Stripe webhooks

The public site (`apps/site`) and admin (`apps/admin`) should call this API; they should not contain backend deployment config.


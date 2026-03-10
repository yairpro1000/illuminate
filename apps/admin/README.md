## Admin (Cloudflare Pages)

Cloudflare Pages project settings:

- Root directory: `apps/admin`
- Build command: *(none)* (static placeholder for now)
- Output directory: `.`

## Shared backend API

- Admin frontend calls `apps/api-booking` under `${API_BASE}/api/admin/*`.
- Organizer UI ownership lives in `apps/admin` (not in `apps/pa`).
- API base resolution order:
	1. `localStorage.admin_api_base` (full base, e.g. `/api` or `https://host/api`)
	2. `window.ENV.VITE_API_BASE` (set via Pages env) + `/api`
	3. Local dev default: `http://localhost:8788/api`
	4. Production default: `https://api.letsilluminate.co/api`
- Manual override still supported: append `?apiBase=https://<backend-host>/api` once; it's saved to localStorage.

Environment variable:

- `VITE_API_BASE` — set in Cloudflare Pages project (Production & Preview)
	- For production: `https://api.letsilluminate.co`
	- Optional for preview: same value, unless testing a staging API

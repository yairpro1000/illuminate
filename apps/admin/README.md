## Admin (Cloudflare Pages)

Cloudflare Pages project settings:

- Root directory: `apps/admin`
- Build command: *(none)* (static placeholder for now)
- Output directory: `.`

## Shared backend API

- Admin frontend calls `apps/api-booking` under `/api/admin/*`.
- Organizer UI ownership lives in `apps/admin` (not in `apps/pa`).
- Default API base: `/api`
- Override for cross-origin setups: append `?apiBase=https://<backend-host>/api` once; the page stores it in localStorage.

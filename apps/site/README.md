## Public site (Cloudflare Pages)

Cloudflare Pages project settings:

## Backend API base

- Public site calls the backend under `${API_BASE}/api/*`.
- API base resolution order:
	1. `localStorage.API_BASE`
	2. `window.ENV.VITE_API_BASE` (if provided)
	3. Local dev default: `http://localhost:8788`
	4. Production default: `https://api.letsilluminate.co`

Environment variable for Cloudflare Pages (Production & Preview):

- `VITE_API_BASE=https://api.letsilluminate.co`

- Root directory: `apps/site`
- Build command: *(none)* (static)
- Output directory: `.`


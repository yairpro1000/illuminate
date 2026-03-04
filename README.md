# Monorepo structure (Pages + Worker)

This repo is structured to deploy **two Cloudflare Pages projects** (public site + admin) from one repository, plus a separate **Cloudflare Worker API**.

## Deployments

### Pages: public site

- Root directory: `apps/site`
- Build command: *(none)* (static)
- Output directory: `.`

### Pages: admin

- Root directory: `apps/admin`
- Build command: *(none)* (static placeholder for now)
- Output directory: `.`

### Worker: API

- Worker project lives in: `api/`

## Notes

- `pa-v1/` is a local-only prototype (Node + Vite) and is **not** deployed to Pages.
- Internal planning docs live in `md/` and `docs/` (not deployed).

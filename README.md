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

### Pages: PA

- Root directory: `apps/pa`
- Build command: `npm install && npm run build`
- Output directory: `dist`

### Worker: API

- Worker project lives in: `api/`

## Notes

- Internal planning docs live in `md/` and `docs/` (not deployed).

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

- `pa-v1/` is the original local prototype (Node + Vite) and is **not** deployed to Pages.
- PA DB scripts:
  - Print DDL: `cd pa-v1 && npx tsx scripts/print_pa_ddl.ts`
  - Import local JSON/JSONL → Supabase: `cd pa-v1 && npx tsx scripts/import_pa_data_to_supabase.ts`
    - Reads `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (can be stored in repo-root `.env`, which is gitignored)
- Internal planning docs live in `md/` and `docs/` (not deployed).

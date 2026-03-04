# PA V1 (Local-only Personal Assistant)

V1 is a local admin web app + local API that turns voice transcripts into **validated JSON actions** and commits them to **file-based storage**:

- List items: `data/lists/<listId>.jsonl` (one JSON object per line)
- Schema registry: `data/meta/lists.schema.json` (single source of truth)

## Quick start

From `pa-v1/`:

1) Install deps

```bash
npm install
```

2) Create the local admin login

```bash
npm run init-auth -- --user admin --pass "choose-a-password"
```

This writes `.env` (and `.env` is ignored by git).

Or set env vars yourself:

- `PA_ADMIN_USER=admin`
- `PA_ADMIN_PASS=...` (plaintext), **or** `PA_ADMIN_PASS_HASH=...` (bcrypt)

3) Run dev (API + web)

```bash
npm run dev
```

Open: `http://localhost:5173`

If the UI shows `API: HTTP 500` during dev, it usually means the Vite proxy can’t reach the API (check the `dev:api` terminal output). You can also verify the API directly at `http://localhost:8787/api/health`.

If port `8787` is taken:

```bash
PA_PORT=8788 npm run dev
```

`.env` is loaded automatically by the API on startup.

## Logging / debugging

By default, logs print to the API console (stdout). To also persist logs to a local file:

- Set `PA_LOG_TO_FILE=true` (optional `PA_LOG_LEVEL=debug|info|warn|error`)
- Logs are written as JSONL to `data/meta/logs/server.jsonl`

Note: logs may include request/LLM error bodies. To avoid sensitive data in logs, leave `PA_LOG_SENSITIVE` unset (default redacts common secret keys).

## Data model

### Schema registry

`data/meta/lists.schema.json` defines lists and fields. Example (trimmed):

```json
{
  "version": 1,
  "lists": {
    "inbox": {
      "title": "Inbox",
      "aliases": ["tasks", "todo"],
      "fields": {
        "text": { "type": "string" },
        "priority": { "type": "int", "default": 3 },
        "color": { "type": "string", "default": null, "nullable": true },
        "order": { "type": "int", "default": 0 }
      }
    }
  }
}
```

### Items (JSONL)

Each line is a JSON object. Reserved fields always exist:

- `id` (uuid)
- `createdAt` (ISO string)

All other fields must be declared in the schema registry.

## API (local)

All endpoints are under `/api` and require login (session cookie):

- `POST /api/parse` → transcript → action JSON
- `POST /api/commit` → validated action → writes files / updates schema
- `GET /api/lists` → lists from schema registry
- `GET /api/lists/:listId/items` → reads JSONL
- `POST /api/lists/:listId/reorder` → persists order changes (within a priority bucket)
- `GET /api/export/:listId.csv`
- `GET /api/export/:listId.xlsx`

## LLM parsing (local-first)

Configure via env vars (optional):

- `PA_LLM_PROVIDER=heuristic` (default): rule-based fallback
- `PA_LLM_PROVIDER=ollama`: calls `OLLAMA_URL` (default `http://localhost:11434`) and `OLLAMA_MODEL`
- `PA_LLM_PROVIDER=openai`: calls OpenAI (requires `OPENAI_API_KEY`, optional `OPENAI_MODEL`)

## Supported action objects

The backend validates (hard) before committing.

- `append_item`: `{ listId|target, fields: { ... } }`
- `update_item`: `{ listId|target, itemId, patch: { ... } }`
- `delete_item`: `{ listId|target, itemId }`
- `create_list`: `{ title, listId?, fields? }` (creates JSONL + updates schema)
- `add_fields`: `{ listId|target, fieldsToAdd: [{ name, type, default?, nullable? }] }` (updates schema + migrates JSONL)

All actions also include:

- `valid: boolean`
- `confidence: number (0..1)`

## Build + run (single process)

```bash
npm run build
npm run start
```

Then open: `http://localhost:8787`

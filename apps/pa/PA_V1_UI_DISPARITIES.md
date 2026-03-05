# PA UI parity vs `pa-v1` (legacy source of truth)

This document summarizes **current UI/UX disparities** between:

- **Legacy (source of truth):** `pa-v1/web/src/ui/*`
- **New PA UI:** `apps/pa/src/ui/*`

Notes:

- Some differences are driven by backend/auth changes (routes moved from `/api/*` to `/pa/*`, Cloudflare Access instead of username/password).
- This report focuses on **user-visible UI/UX and interaction behavior** first, then calls out non-UI technical diffs that can still affect UX.

## File inventory

Both sides contain:

- `App.tsx`, `Main.tsx`, `ListBrowser.tsx`, `VoicePanel.tsx`, `ReorderBucket.tsx`
- `listBrowser/{components.tsx,constants.ts,utils.ts}`, `speech.ts`

Legacy-only:

- `pa-v1/web/src/ui/Login.tsx` (missing in `apps/pa`)

## Disparities by area

### App shell (`App.tsx`)

Legacy:

- Shows `PA V1` title and a **Login** card (`Login.tsx`) when not authenticated.
- Identifies the user by `username`.
- Uses `/api/me` and `/api/config`.

New:

- Shows `PA` title.
- Shows an **“Access required”** card instead of the login UI.
- Identifies the user by `email`.
- Uses `/pa/me` and `/pa/config`.

User-visible impact:

- Authentication UX is different (login form vs Cloudflare Access message).
- Topbar title/tagline differs.

### Main header (`Main.tsx`)

Legacy:

- Shows `PA V1`.
- Shows a **Sign out** button.

New:

- Shows `PA`.
- No sign-out button.

User-visible impact:

- No explicit sign-out affordance in the new UI.

### Voice flow (`VoicePanel.tsx`) — largest UI divergence

Legacy UI/flow:

- Title: “Voice → Action → Confirm”.
- Buttons: mic toggle (`Mic 🎙` / `Stop 🎙`), `Parse`, `Confirm & Commit`, `Edit JSON` toggle, `Cancel`.
- Shows validity + confidence pill (`valid`, `confidence`).
- Commit is disabled when `action.valid === false` (unless editing JSON).
- Cancel clears transcript/action and stops the mic.

New UI/flow:

- Title: “Voice”.
- Mic button label differs (recent bug was `Mic off`; now fixed to `Mic`/`Stop`).
- Separate `Parse` and `Commit` layout; no `Cancel`.
- No validity/confidence display; commit gating is looser (primarily “action exists”, then server-side validation).
- JSON editing UX differs (checkbox + `<pre>` view in non-edit mode).

User-visible impact:

- Different mental model and safeguards (confirm step, validity gating, cancel/reset).
- Different information density (no valid/confidence).

Status:

- `apps/pa/src/ui/VoicePanel.tsx` has been restored to the legacy flow (parse → confirm/commit, edit JSON toggle, cancel/reset, valid/confidence display), with endpoints updated to `/pa/*`.

### List browsing (`ListBrowser.tsx`)

Legacy:

- Includes both CSV and XLSX export links (`/api/export/<list>.csv` and `.xlsx`).
- No “stale view” banner.
- No explicit conflict messaging beyond generic API errors.

New:

- CSV export link exists but points to `/pa/export/<list>.csv`.
- XLSX export link exists and points to `/pa/export/<list>.xlsx`.
- Adds **stale view detection** (polls list `meta.revision`) and shows a banner prompting refresh.
- Adds more explicit “Conflict: data changed elsewhere…” messaging when commit fails with a conflict.

User-visible impact:

- XLSX export missing (if users relied on it).
- New “stale” banner appears and adds a refresh CTA.
- Clearer conflict errors.

### Reorder bucket (`ReorderBucket.tsx`)

Legacy:

- Fully self-contained reorder UI using `useSortable` and a local `SortableRow`.
- Props: `items`, `priority`, `onSave(orderedIds)`.

New (before sync):

- Diverged into an API-calling component with different props (`listId`, `expectedRevision`, etc.).
- Imported a `SortableRow` that did not exist (latent build error if ever imported).

Status:

- `apps/pa/src/ui/ReorderBucket.tsx` is now synced back to the legacy UI shape to match `pa-v1` and eliminate the broken import.

### Color pickers / details menus (`listBrowser/components.tsx` + `ListBrowser.tsx`)

Legacy:

- Uses a shared hook `useDismissibleDetails(ref)` to close `<details>` menus on:
  - click outside
  - Escape key

New:

- Had regressed (no longer reliably closed).

Status:

- New now re-exports `useDismissibleDetails(ref)` and applies it to:
  - row-level color picker (`ColorPicker`)
  - add-item color picker (`ColorSelect`)
  - filter color picker menu (`ListBrowser.tsx` `filterColorMenuRef`)

### Styling (`styles.css`)

Legacy:

- Contains the full stylesheet in `pa-v1/web/src/styles.css`.

New:

- `apps/pa/src/styles.css` imports the legacy stylesheet via `@import "../../../pa-v1/web/src/styles.css";`.

User-visible impact:

- Should match legacy as long as the import path continues to resolve in the build.

## Non-UI diffs that can affect UX

### `api.ts`

New adds:

- `VITE_API_BASE` prefix support.
- `x-pa-device-id` header (stable per-browser via localStorage).

Potential UX impact:

- Better diagnostics/auditing server-side, but behavior depends on backend expectations.

### `speech.ts`

New uses DOM `SpeechRecognition` types and exports a `SpeechRecognitionCtor`.

Potential UX impact:

- None directly, but affects TS typing and may influence browser compatibility error handling.

## Suggested priority list (if aligning strictly to legacy UI)

1. Decide desired auth UX parity (keep Cloudflare Access card vs reintroduce a login/sign-out surface).
2. Restore legacy `VoicePanel` flow (confirm/commit gating, cancel/reset, valid/confidence pills) or explicitly bless the new flow.
3. Decide whether XLSX export should exist in the new backend; if yes, restore the UI affordance.
4. Keep `useDismissibleDetails` as a shared hook and apply it to any other `<details>` menus added in the future.

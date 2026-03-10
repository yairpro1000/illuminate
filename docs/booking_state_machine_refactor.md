# Booking State Machine Refactor — Change Report

Date: 2026-03-09

## Overview

This change introduces a centralized state-machine-based lifecycle for bookings with a small top-level status and orthogonal sub-statuses. It coexists with legacy fields for a safe, incremental migration.

## Files Created
- apps/api-booking/src/domain/booking-domain.ts — Domain enums + legacy→state mapper
- apps/api-booking/src/services/booking-transition.ts — Transition layer + audit event writer
- apps/api-booking/migrations/011_booking_state_machine.sql — ALTER-based migration and backfill
- apps/api-booking/test/booking-transition.test.ts — Vitest unit tests for mapper
- apps/api-booking/vitest.config.ts — Vitest config

## Files Modified (highlights)
- apps/api-booking/src/types.ts — Added new lifecycle fields and enums (backward compatible)
- apps/api-booking/src/services/booking-service.ts — Calls transition layer; enforces late Stripe rule
- apps/api-booking/src/providers/repository/interface.ts — Added booking_events + side_effects APIs
- apps/api-booking/src/providers/repository/supabase.ts — Implemented new repository methods
- apps/api-booking/src/handlers/slots.ts — Enforce 24h minimum lead time
- apps/api-booking/package.json — Added Vitest + scripts

## Old Flow vs New Flow
- Old: procedural transitions encoded across handlers/services, single legacy `status` encodes multiple concerns.
- New: centralized transition service writes:
  - booking_status: pending | confirmed | cancelled | expired
  - payment_mode: free | pay_now | pay_later
  - payment_status_v2: not_required | pending | paid
  - email_status: not_required | pending_confirmation | confirmed | expired
  - calendar_status: not_required | pending | created | removed
  - slot_status: reserved | released
- All major entry points (create pay-now/pay-later, email confirm, Stripe webhook, expire, cancel, reschedule) now emit `booking_events` and synchronize new lifecycle fields.

## Cron Jobs
- Unified cron sweep runs every minute and maps to the same concepts:
  - expire pending holds → HOLD_EXPIRED
  - pay-later 36h reminder → PAY_LATER_REMINDER_DUE
  - pay-later payment-deadline cancellation → PAYMENT_DEADLINE_MISSED
  - 24h reminders

Wrangler triggers remain: [apps/api-booking/wrangler.toml](apps/api-booking/wrangler.toml#L1).

## Schema Changes
- New columns on `bookings`: booking_status, payment_mode, payment_status_v2, email_status, calendar_status, slot_status, hold_expires_at, email_confirmed_at, confirmed_at, cancelled_at, expired_at, reminder_36h_sent_at, last_payment_link_sent_at, expired_reason, cancel_reason, metadata(jsonb)
- New tables:
  - booking_events(booking_id, event_type, source, payload, created_at)
  - booking_side_effects(optional outbox)
- Backfill derives new fields from legacy `status`, `checkout_hold_expires_at`, `payment_due_at`, `google_event_id`, `source`, `session_type`.

## API/UI Behavior Changes
- Slots endpoint now hides slots < 24h ahead (was 15 min). UI already respects backend response; optional CTA for urgent bookings can be added in a separate pass.
- Stripe late payment policy: If a webhook arrives after booking is `expired` or `cancelled`, we no longer revive the booking. We persist payment success, record a `PAYMENT_SUCCEEDED` event with `late: true`, and keep booking inactive. Operator can follow up manually if desired.

## Existing Data Migration Notes
- Mapping rules in migration:
  - booking_status: from legacy `status`
  - payment_mode: session intro → free; session + checkout_hold → pay_now; session with payment_due_at → pay_later; event paid → pay_now; event free → free/pay_later per dues
  - payment_status_v2: paid for pay_now+confirmed; pending otherwise except free
  - email_status: not_required for pay_now; pending_confirmation for pending_email; confirmed otherwise; expired maps through
  - calendar_status: sessions only — created if `google_event_id` present; pending if confirmed or pay_later; not_required otherwise
  - slot_status: reserved if confirmed or active hold; released otherwise
- Defaults: when in doubt, conservative `pending` lifecycle with `slot_status = released` unless hold is active.
- Manual review recommended for any bookings where:
  - legacy `status = pending_payment` but both `checkout_hold_expires_at` and `payment_due_at` are null
  - event paid/free ambiguity (rare)

## Tests Summary
- Added unit tests for legacy→state mapper covering pay_now pending, pay_later confirmed, free confirmed.
- Test runner: Vitest (`pnpm/yarn/npm run test`).

## Edge Cases & Tradeoffs
- For now, we maintain legacy `status` alongside new lifecycle fields. Queries/jobs still using legacy columns continue to work. As a follow-up, jobs and reads can be migrated to the new columns.
- Side-effects outbox is created but not yet wired; current code still sends emails inline with best-effort logging. This can be migrated to outbox pattern later.
- Calendar status is derived; future work can record `created/removed` transitions explicitly.

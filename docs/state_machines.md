# State Machines

This document defines explicit status lifecycles and transitions for **Bookings (1:1 sessions)** and **Event Bookings**.

## Bookings (1:1 sessions)

**Statuses:** `pending_email`, `pending_payment`, `confirmed`, `cash_ok`, `cancelled`, `expired`

### Transition Table

| From | Trigger | To | Notes |
|---|---|---|---|
| — | Create booking (Pay Later) | `pending_email` | Create `confirm_token_hash` + `confirm_expires_at`; send confirm email; set `followup_scheduled_at = now + 2h`. No calendar event yet. |
| `pending_email` | Email confirmed within window | `pending_payment` | Create calendar event; set `payment_due_at = starts_at - 24h`; compute `payment_due_reminder_scheduled_at`; send “pay now” link email. |
| `pending_email` | `confirm_expires_at` reached | `expired` | Slot never reserved; no calendar event. |
| `pending_email` | `followup_scheduled_at` reached and not confirmed | `pending_email` | Send **one** follow-up email; set `followup_sent_at`. |
| — | Create booking (Pay Now) | `pending_payment` | Create Stripe Checkout; set `checkout_hold_expires_at = now + 15m`. |
| `pending_payment` | Stripe webhook success | `confirmed` | Persist Stripe refs + invoice_url; create calendar event if missing; send confirmation email (address + maps + manage link). |
| `pending_payment` | `checkout_hold_expires_at` reached (Pay Now) and unpaid | `expired` | Release hold; no calendar event. |
| `pending_payment` | `payment_due_at` reached (Pay Later) and unpaid | `cancelled` | Cancel booking; remove/mark cancelled calendar event; send cancellation email. |
| `pending_payment` | Admin sets cash on location | `cash_ok` | Bypasses auto-cancel at `payment_due_at`. |
| `cash_ok` | Admin records payment later | `confirmed` | Optional transition. (Alternative: keep `cash_ok` and store payment record; choose one convention.) |
| `confirmed` | User cancels via manage link | `cancelled` | Enforce policy cutoffs (e.g., no cancel within 24h) as product decision. |
| `confirmed` | User reschedules via manage link | `confirmed` | Update calendar event time; preserve payment linkage. |
| any | Admin cancels | `cancelled` | Ensure calendar event is removed/updated and user notified. |

### Invariants

- `pending_email` ⇒ booking is **not reserved** yet; no calendar event exists.
- `pending_payment` can mean:
  - Pay Now: reserved only until `checkout_hold_expires_at`.
  - Pay Later: reserved (calendar event exists) but must be paid by `payment_due_at`.
- Stripe webhooks must be **idempotent** (may arrive more than once).

### Reminder Timing Rules (Payment Due)

For pay-later bookings:

- `payment_due_at = starts_at - 24h`
- preferred reminder time: `payment_due_at - 6h`
- if that falls in **sleep hours** (22:00–08:00 local time), snap to **18:00 day-before**
- if 18:00 day-before already passed, snap to **08:00 next reasonable morning**

Persist:
- `payment_due_reminder_scheduled_at`
- `payment_due_reminder_sent_at`

---

## Event Bookings

**Statuses:** `pending_email`, `pending_payment`, `confirmed`, `cancelled`, `expired`

### Transition Table

| From | Trigger | To | Notes |
|---|---|---|---|
| — | Book free event | `pending_email` | Phone required; set `confirm_expires_at = now + 15m`; set `followup_scheduled_at = now + 2h`; send confirm email. |
| `pending_email` | Email confirmed within 15m | `confirmed` | Send confirmation email (maps + manage link); schedule 24h reminder if opted in. |
| `pending_email` | `confirm_expires_at` reached | `expired` | Seat released. |
| `pending_email` | `followup_scheduled_at` reached and not confirmed | `pending_email` | Send **one** follow-up; set `followup_sent_at`. |
| — | Book paid event | `pending_payment` | Create Stripe Checkout; set `checkout_hold_expires_at`. |
| `pending_payment` | Stripe webhook success | `confirmed` | Store payment refs + invoice_url; send confirmation; schedule 24h reminder if opted in. |
| `pending_payment` | +2h unpaid reminder reached and not paid | `pending_payment` | Send **one** “complete payment” reminder; set `followup_sent_at`. |
| `pending_payment` | `checkout_hold_expires_at` reached and unpaid | `expired` | Do not count toward capacity. |
| `confirmed` | User cancels via manage link | `cancelled` | Enforce policy cutoffs as product decision. |
| any | Admin cancels | `cancelled` | Notify user as product requires. |
| — | Book event via valid late-access link | `confirmed` or `pending_payment` | Same booking lifecycle as normal event booking; late-access only bypasses the public time cutoff. |

### Capacity Rule (recommended)

- Capacity should be decremented only when `status = confirmed`.
- One booking row represents one attendee.
- There is no separate event registration, guest, or attendee table in the current design.

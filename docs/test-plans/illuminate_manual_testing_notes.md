# ILLUMINATE Manual Testing Notes

## Purpose
This is the lean manual testing companion for the current solo build phase.

Use the spreadsheet as the main execution artifact.  
Use this note only for scope, order, and simple ground rules.

## What to test first
Run in this order:

1. P0 tests
2. Payment and booking flows again after any fix
3. Manage-booking flows
4. Organizer auth and bookings page
5. Content/admin edits
6. P1 tests
7. P2 only if time allows

## What counts as release-blocking right now
Treat these as blockers:

- a primary booking CTA opens the wrong flow
- free booking does not ask for email confirmation
- paid booking does not reach Stripe correctly
- successful payment leaves the user stuck
- manage link cannot open a valid booking
- cancel/reschedule rules are clearly wrong
- organizer pages leak without sign-in
- organizer cannot load/edit bookings
- event/session public state is clearly wrong (bookable vs sold out vs closed vs past)

## Ground rules
## Must-cover booking invariants
Add and keep these as explicit P0 scenarios:

- booked slot becomes unavailable to the next user/session
- canceled slot becomes available again
- if two users race for the same slot, only one booking can win at submit time and the other user gets a clean "slot just taken" message

- Keep the sheet lean.
- Add a new test row only if it protects a real production flow.
- Do not add weird edge cases unless they are already causing risk.
- Retest the exact broken path after every fix.
- When in doubt, prefer one short executable test over a long prose explanation.

## Minimal data checklist
Fill these in for each environment:

- organizer login:
- public base URL:
- intro offer URL:
- paid 1:1 offer URL:
- free evening URL:
- paid evening URL:
- valid manage link:
- expired manage link:
- valid confirmation link:
- expired confirmation link:
- valid late-access link:
- expired/rotated late-access link:
- Stripe test card:
- bug tracker / notes location:

## Suggested bug note format
Use one line in the spreadsheet notes cell:

`Observed: ... | Expected: ... | Link: ...`

## Out of scope for now
- exhaustive browser matrix
- localization deep pass
- accessibility audit deep pass
- performance/load testing
- rare pathological edge cases unless already suspected
- broad beta/usability feedback collection

## Rule of thumb
This pack is for getting to stable alpha safely, not for writing a test encyclopedia.

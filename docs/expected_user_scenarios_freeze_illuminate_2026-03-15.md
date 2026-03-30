# Expected User Scenarios Freeze - 2026-03-15

## Scope

This freeze covers the ILLUMINATE public website, booking flows, payment recovery paths, self-service booking management, organizer/admin tooling, content editing, reminder capture, and timing/config surfaces served by `apps/site`, `apps/admin`, and `apps/api-booking`.

Excluded:

- PA / Personal Assistant flows
- purely internal implementation details unless they directly change an observable outcome

## Documentation Location

- Confirmed documentation folder: `docs/`
- Governing pay-later refinement: [pay_later_refined_flow_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/pay_later_refined_flow_2026-03-15.md)
- Live schema reference used during this pass: [public_schema_snapshot_2026-03-15.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/old/public_schema_snapshot_2026-03-15.sql)

## Iteration Summary

- Iteration 1: mapped current routes, pages, and API handlers from `apps/site`, `apps/admin`, and `apps/api-booking`
- Iteration 2: cross-checked flows against automated coverage in `apps/site/e2e`, `apps/site/tests`, `apps/admin/tests`, and `apps/api-booking/test`
- Iteration 3: applied the 2026-03-15 pay-later refinement as the explicit override where older behavior or stale tests diverged

## Scenario List

- `S01` Public sessions page shows only currently available 1:1 offers
- `S02` Public evenings page shows the correct registration state for each event
- `S03` Reminder signup works for unavailable evenings without creating a booking
- `S04` Contact form succeeds when contact capture is accepted
- `S05` Free intro booking submits into email confirmation, not instant confirmation
- `S06` Paid 1:1 booking reaches either checkout, email confirmation, or effective-free handling based on final price and trusted actor state
- `S07` Paid 1:1 pay-later booking uses email confirmation first unless a trusted admin actor confirms it immediately
- `S08` Free evening registration submits into email confirmation
- `S09` Paid evening registration reaches either checkout, email confirmation, or effective-free handling based on final price and trusted actor state
- `S10` Valid late-access links can still open closed free evenings for registration
- `S11` Confirmation links advance the visitor to the next valid public action
- `S12` Payment-success recovery works even when email is delayed
- `S13` Manage links show the current state and only the allowed self-service actions
- `S14` Eligible 1:1 bookings can be rescheduled to a new slot
- `S15` Eligible bookings can be canceled and end in a canceled state
- `S16` Invalid or expired links fail explicitly instead of producing vague broken states
- `S17` Organizer access is intended to require sign-in before organizer tooling is used
- `S18` Organizer can load, filter, edit, and settle bookings from the bookings workbench
- `S19` Organizer can generate manage links and rotate late-access links
- `S20` Organizer can review inbound contact messages
- `S21` Organizer can create and edit session types, including image-backed fields
- `S22` Organizer can edit event records and timing/config values
- `S23` Slot contention, slot holds, and slot release behave consistently across users
- `S24` Organizer-authorized booking creation can skip confirmation-request email and finalize directly

## Scenarios By Domain

### `S01` Visitor sees only currently available 1:1 offers and can enter the correct booking flow

Given: A visitor opens the public sessions page while at least zero or more public session types exist.

Expected: The page shows only currently public session offers and each visible offer opens the matching booking flow.

Visible steps:
- Visitor opens `sessions.html`
- Visitor sees the currently public offers
- Visitor clicks the CTA for one offer

Clarification:
The intro conversation opens the intro booking flow. Paid 1:1 offers open the paid session booking flow with the correct offer slug. If no public offers exist, the page shows a clear empty state.

Artifacts:
- session cards
- booking CTA URLs

Behind-the-scenes dependencies:
- `GET /api/session-types`

### `S02` Visitor sees each ILLUMINATE Evening in the correct public registration state

Given: A visitor opens the evenings page while events may be upcoming, past, sold out, or closed.

Expected: Each event card shows the correct public state and only the actions that match that state.

Visible steps:
- Visitor opens `evenings.html`
- Visitor switches between Upcoming and Past tabs
- Visitor sees either booking, reminder signup, or closed-state affordances

Clarification:
Upcoming and past events are separated. Sold-out and closed events are not falsely bookable. Reminder signup replaces booking only when public booking is unavailable but reminder capture is still offered.

Artifacts:
- upcoming events tab
- past events tab
- state badges
- booking or reminder CTA

Behind-the-scenes dependencies:
- `GET /api/events`
- event render metadata from the backend

### `S03` Visitor can join reminders for an unavailable evening without creating a booking

Given: A visitor sees an evening card that offers reminder signup instead of normal booking.

Expected: Submitting the reminder form shows immediate reminder success and does not create a booking or payment flow.

Visible steps:
- Visitor opens the reminder form
- Visitor enters email and optional name fields
- Visitor submits the reminder form

Artifacts:
- reminder form
- reminder success message
- reminder subscription record

Behind-the-scenes dependencies:
- `POST /api/events/reminder-subscriptions`

### `S04` Visitor can send a contact message and receive success once contact capture is accepted

Given: A visitor opens the public contact form with valid required fields available.

Expected: Once the message is accepted and stored, the visitor sees success even if downstream notification delivery later fails.

Visible steps:
- Visitor fills first name, email, and message
- Visitor completes anti-bot verification when enabled
- Visitor submits the form

Clarification:
Validation errors stay inline on the form. Success is tied to accepted contact capture, not guaranteed email delivery.

Artifacts:
- contact form
- inline validation states
- success state
- stored contact message

Behind-the-scenes dependencies:
- `POST /api/contact`
- anti-bot verification path

### `S05` Visitor can submit a free intro booking and is told to confirm it by email

Given: A visitor chooses a valid intro slot and completes the booking form.

Expected: The booking is created in a pending state and the visitor is told to confirm it by email before it becomes confirmed.

Visible steps:
- Visitor opens `book.html?type=intro`
- Visitor chooses a slot
- Visitor enters contact details
- Visitor submits the booking

Clarification:
This is not an instant-confirm flow. The slot becomes truly reserved only after the email confirmation link is redeemed.

Artifacts:
- pending booking
- confirmation-request email
- confirmation link

Behind-the-scenes dependencies:
- slot availability check
- tokenized email confirmation flow

### `S06` Visitor can submit a paid 1:1 booking and the final computed price decides whether payment is skipped

Given: A visitor chooses a valid paid 1:1 session slot and selects Pay Now.

Expected: Submission creates either a normal paid checkout path for a positive final price or a free-booking confirmation path when coupon application reduces the final price to zero.

Visible steps:
- Visitor opens a paid session booking flow
- Visitor chooses a slot
- Visitor enters contact details
- Visitor selects Pay Now
- Visitor reviews the booking and either proceeds to payment or sees the non-paid confirmation path when the final price is zero

Clarification:
Coupon evaluation happens before the effective booking mode is finalized. If a paid 1:1 booking ends with `finalPrice = 0`, it must not create a payment row, must not schedule payment side effects, must skip payment-choice handling, and must behave like a free booking from submit onward while still preserving the coupon snapshot on the booking.

Artifacts:
- pending booking
- pending payment row only when final price is positive
- checkout session URL only when final price is positive
- payment success / cancel return URLs only when final price is positive
- no payment row and no payment side effects when final price is zero

Behind-the-scenes dependencies:
- `POST /api/bookings/pay-now`
- payments provider checkout bootstrap

### `S07` Visitor can submit a paid 1:1 session booking with Pay Later and confirmation starts the payment flow unless a trusted admin actor confirms it immediately

Given: A visitor chooses a valid paid 1:1 session slot and selects Pay Later.

Expected: Submission sends only the confirmation-request email; after email confirmation, the booking becomes confirmed and the payment flow is initiated.

Visible steps:
- Visitor opens a paid session booking flow
- Visitor chooses a slot
- Visitor enters contact details
- Visitor selects Pay Later
- Visitor submits the booking
- Visitor receives a confirmation-request email
- Visitor confirms the email

Clarification:
The March 15, 2026 pay-later refinement governs this scenario. On submit, the booking remains `PENDING` and no Stripe invoice is created yet. On confirmation, the booking becomes `CONFIRMED`, a payment row is created immediately, Stripe invoice bootstrap is attempted synchronously, and the visitor receives a confirmed-style subject line with payment still pending. If Stripe bootstrap fails, confirmation still succeeds and later `continue-payment` must bootstrap payment from scratch. `continue-payment` is a checkout recovery path, not an invoice-document redirect.

If the creation request carries a valid admin token, the confirmation-request step is skipped entirely. The booking is treated as already confirmed by a trusted actor and immediately reuses the normal confirmation/finalization owner for reservation, confirmed email dispatch, and downstream side effects. Invalid admin tokens fail closed with the standard auth failure outcome instead of downgrading to the public flow.

Artifacts:
- pending booking after submit
- confirmation-request email
- confirmed booking after email confirmation
- payment row created after confirmation
- invoice URL when available
- confirmed-but-unpaid confirmation email

Behind-the-scenes dependencies:
- `POST /api/bookings/pay-later`
- `GET /api/bookings/confirm`
- payment bootstrap fallback via `GET /api/bookings/continue-payment`

### `S08` Visitor can submit a free evening registration and is told to confirm it by email

Given: A visitor opens a free public evening and completes the registration form.

Expected: The registration is accepted into a pending state and requires email confirmation before it becomes confirmed.

Visible steps:
- Visitor opens the evening booking flow
- Visitor enters details
- Visitor submits the registration

Artifacts:
- pending event booking
- confirmation-request email
- confirmation link

Behind-the-scenes dependencies:
- `POST /api/events/:slug/book`

### `S09` Visitor can submit a paid evening registration and the final computed price plus actor state decide the next path

Given: A visitor opens a paid public evening and completes the registration form.

Expected: Submission redirects into checkout for a positive final price when the booking is using the pay-now path, uses the email-confirm path for pay-at-event, and behaves like a free registration when coupon application reduces the final price to zero.

Visible steps:
- Visitor opens the paid evening booking flow
- Visitor enters details
- Visitor submits the registration

Artifacts:
- pending booking
- pending payment row only when final price is positive and the booking mode needs payment work
- checkout session URL only for checkout-backed positive-price paths

Clarification:
If coupon application reduces a paid event registration to `0`, the booking must be handled as free from submit onward: no payment row, no payment side effects, and the non-paid confirmation path applies. A valid admin-authorized create may also skip the confirmation-request step and finalize directly through the shared confirmed-booking owner.

Behind-the-scenes dependencies:
- `POST /api/events/:slug/book`
- payments provider checkout bootstrap

### `S10` Visitor with a valid late-access link can still register for a closed free evening

Given: A visitor has a valid, unrevoked late-access link for a free event that is no longer publicly bookable.

Expected: The late-access flow still allows registration and reaches the normal booking confirmation outcome.

Visible steps:
- Visitor opens the late-access URL
- Visitor enters details
- Visitor submits the registration

Clarification:
Old or revoked late-access links must fail cleanly. The late-access path is controlled by organizer-generated rotating links.

Artifacts:
- late-access URL
- booking created through late-access path

Behind-the-scenes dependencies:
- `POST /api/events/:slug/book-with-access`
- token-hash validation against active late-access links

### `S11` Visitor can open a confirmation link and be sent to the next valid public action

Given: A visitor opens a valid confirmation link from a confirmation-request email.

Expected: The backend confirms the booking when allowed and returns the correct next public action for that booking state.

Visible steps:
- Visitor opens `confirm.html?token=...`
- Visitor sees either a confirmed state or an explicit expired/failure state

Clarification:
Free bookings end at confirmed/manage behavior. Pay-later bookings become `CONFIRMED` and expose `Complete Payment` as the next action when payment remains online-continuable. Expired confirmation links show an explicit expired outcome instead of a vague failure.

Artifacts:
- confirmed page
- next action URL
- next action label

Behind-the-scenes dependencies:
- `GET /api/bookings/confirm`
- booking status and payment-status gating

### `S12` Visitor can recover from a completed checkout through the payment-success path even if email is delayed

Given: A visitor lands on the payment-success page with a provider checkout session id.

Expected: The page resolves the booking and shows the correct next step even if the confirmation email has not arrived yet.

Visible steps:
- Visitor lands on `payment-success(.html)?session_id=...`
- Visitor sees either a confirmed recovery state or an in-progress recovery state
- Visitor uses the returned action link

Artifacts:
- payment-success recovery page
- manage link or next action link

Behind-the-scenes dependencies:
- `GET /api/bookings/payment-status`

### `S13` Visitor can open a manage link and see the current booking state plus only the allowed actions

Given: A visitor opens a valid manage link for an existing booking.

Expected: The manage page shows the current booking details, payment details when relevant, and only the actions allowed by source, status, and policy window.

Visible steps:
- Visitor opens `manage.html?token=...`
- Visitor sees booking details and state badges
- Visitor sees zero or more allowed self-service actions

Clarification:
Event bookings do not expose self-reschedule. Locked bookings suppress restricted actions and show the locked policy message. Pay-later bookings may show payment status and due date without turning the manage page itself into the payment CTA surface.

Artifacts:
- manage page
- status badge
- payment status row
- payment due row when applicable
- allowed action buttons

Behind-the-scenes dependencies:
- `GET /api/bookings/manage`
- booking policy timing config

### `S14` Visitor can reschedule an eligible 1:1 booking to a new slot from the manage flow

Given: A visitor opens a valid manage link for a self-service-eligible 1:1 booking.

Expected: The visitor can choose a new valid slot and the booking moves to the new time while staying in the correct lifecycle.

Visible steps:
- Visitor opens the manage page
- Visitor chooses Reschedule
- Visitor chooses a new slot
- Visitor submits the reschedule

Artifacts:
- updated booking timestamps
- updated calendar event when calendar sync succeeds

Behind-the-scenes dependencies:
- `POST /api/bookings/reschedule`
- slot availability re-check at submit time

### `S15` Visitor can cancel an eligible booking from the manage flow and see the canceled end state

Given: A visitor opens a valid manage link for a cancellable booking.

Expected: Cancellation ends in a clear canceled state and the slot becomes available again when applicable.

Visible steps:
- Visitor opens the manage page
- Visitor chooses Cancel
- Visitor confirms the cancellation

Clarification:
Paid bookings may later trigger refund handling; free bookings still end in canceled state without payment work. A canceled 1:1 slot is released for future availability.

Artifacts:
- canceled booking state
- cancellation confirmation UI
- released slot for 1:1 bookings

Behind-the-scenes dependencies:
- `POST /api/bookings/cancel`

### `S16` Invalid or expired confirmation/manage links fail explicitly

Given: A visitor opens an invalid, malformed, expired, or no-longer-usable public link.

Expected: The page shows a clear explicit failure state instead of a broken generic page.

Visible steps:
- Visitor opens the bad or expired link
- Visitor sees a specific invalid/expired/could-not-open outcome

Artifacts:
- explicit fallback or expired page copy

Behind-the-scenes dependencies:
- token validation
- lifecycle-state gating

### `S17` Organizer must be signed in before using organizer tools

Given: An organizer opens the admin application in an environment where organizer auth is enabled.

Expected: Unauthenticated access is blocked and the organizer is directed into the sign-in path before using organizer tooling.

Visible steps:
- Organizer opens an admin page
- Organizer sees the sign-in requirement when not authenticated

Clarification:
The codebase still includes an environment-level bypass for temporary pre-prod use. That bypass is an environment override, not the target organizer contract.

Artifacts:
- admin sign-in requirement
- Cloudflare Access login entry

Behind-the-scenes dependencies:
- admin auth gate
- optional environment bypass flag

### `S18` Organizer can load, filter, edit, and settle bookings from the bookings workbench

Given: An authenticated organizer opens the bookings workbench.

Expected: The organizer can inspect booking/payment details, filter rows, edit supported fields, generate manage links, mark cash arrangements, and manually settle eligible bookings.

Visible steps:
- Organizer loads bookings
- Organizer filters by source/date/client/search
- Organizer opens a booking modal
- Organizer edits booking/client/payment-related fields
- Organizer can mark `CASH_OK` or manually settle eligible unpaid bookings

Clarification:
Manual settlement is allowed for eligible `PENDING` or `CONFIRMED` paid bookings and is denied for terminal or incompatible states. The workbench surfaces both booking and payment lifecycle information together for diagnosis.

Artifacts:
- organizer bookings table
- editable modal
- settlement action
- generated manage links

Behind-the-scenes dependencies:
- `/api/admin/bookings`
- `/api/admin/bookings/:bookingId`
- `/api/admin/bookings/:bookingId/payment-settled`
- `/api/admin/bookings/:bookingId/manage-link`
- `/api/admin/bookings/:bookingId/client-manage-link`

### `S19` Organizer can generate privileged booking links and rotate an evening late-access link

Given: An authenticated organizer is working with a booking or event in admin.

Expected: The organizer can generate a client-safe manage link, generate an admin-privileged manage link, and rotate late-access links so the old link stops working and the new link works.

Visible steps:
- Organizer opens a booking
- Organizer copies the client-safe manage link
- Organizer opens the privileged manage link
- Organizer rotates an event late-access link

Artifacts:
- client-safe manage URL
- admin manage URL with `admin_token`
- new late-access URL
- revoked old late-access URL

Behind-the-scenes dependencies:
- late-access token hashing and revocation

### `S20` Organizer can review inbound contact messages with filters, sorting, and full-message view

Given: An authenticated organizer opens the admin contact-messages page with stored contact messages present.

Expected: The organizer can filter the list, inspect message metadata, and open the full message body.

Visible steps:
- Organizer opens the contact-messages page
- Organizer filters by date/client/text
- Organizer opens a message preview

Artifacts:
- contact message table
- filter controls
- modal or overlay with full message body

Behind-the-scenes dependencies:
- `/api/admin/contact-messages`

### `S21` Organizer can create or edit session types, including image-backed content fields

Given: An authenticated organizer opens the session-types admin page.

Expected: The organizer can create and edit session offers, including status, ordering, pricing, descriptive content, and image-backed fields.

Visible steps:
- Organizer opens the session-types page
- Organizer creates or edits a session type
- Organizer uploads or links image-backed content
- Organizer saves changes

Artifacts:
- session type list
- create/edit modal
- uploaded image key or drive id

Behind-the-scenes dependencies:
- `/api/admin/session-types`
- `/api/admin/upload-image`

### `S22` Organizer can edit existing events and timing/config values that control booking behavior

Given: An authenticated organizer opens the admin events/config surfaces.

Expected: The organizer can edit event records and update timing/config values that affect public behavior, reminders, and self-service rules.

Visible steps:
- Organizer edits event title, timing, capacity, status, payment settings, and content
- Organizer edits timing/config values in the config page

Clarification:
Timing/config changes are production-significant because they affect slot lead time, confirmation windows, payment deadlines, reminder timing, late-access expiry, and self-service lock windows.

Artifacts:
- events editor
- config settings table
- saved timing values

Behind-the-scenes dependencies:
- `/api/admin/events`
- `/api/admin/events/:eventId`
- `/api/admin/config`

### `S23` Slot contention, slot holds, and slot release behave consistently across users

Given: Two visitors interact with the same 1:1 slot or an existing booking changes state.

Expected: Only one visitor can win a contested slot, booked slots disappear for later visitors, and canceled slots return to availability.

Visible steps:
- Two visitors choose the same slot near the same time
- One visitor completes the winning path
- The other visitor receives a clean slot-taken outcome
- Later cancellation releases the slot again

Clarification:
This applies across free, pay-now, and pay-later booking modes. The loser must get a clean recovery path instead of a corrupted state.

Artifacts:
- slot-taken error state
- updated slot availability
- restored slot after cancellation

Behind-the-scenes dependencies:
- overlap guard in booking persistence
- held-slot visibility in slot generation

### `S24` Organizer-authorized booking creation can skip confirmation-request email and finalize directly

Given: An organizer creates a booking through a surface that carries a valid admin token for creation.

Expected: The booking skips the confirmation-request email and is finalized immediately through the same shared confirmation/finalization path used after normal confirmation.

Visible steps:
- Organizer opens an admin-authorized booking creation flow
- Organizer submits the booking with a valid admin token
- The recipient receives the confirmed email directly

Clarification:
This applies independently of coupon pricing. If the final computed price is `0`, the result is a confirmed free booking with no payment row or payment side effects. If the final price is positive, the booking still skips the confirmation-request step but retains the correct paid or pay-later commercial semantics. Invalid admin tokens fail closed with the normal auth error envelope.

Artifacts:
- confirmed booking
- confirmed email
- absence of confirmation-request email
- absence of payment row and payment side effects when final price is `0`

Behind-the-scenes dependencies:
- admin-token verification on booking creation
- shared booking confirmation/finalization owner

## Scenarios By Flow

### Discovery and lead capture

- `S01`
- `S02`
- `S03`
- `S04`

### Public booking and registration

- `S05`
- `S06`
- `S07`
- `S08`
- `S09`
- `S10`

### Post-submit recovery and self-service

- `S11`
- `S12`
- `S13`
- `S14`
- `S15`
- `S16`

### Organizer/admin operations

- `S17`
- `S18`
- `S19`
- `S20`
- `S21`
- `S22`
- `S24`

### Cross-user integrity

- `S23`

## Behind-the-Scenes Dependencies

- Public flows depend on the booking worker for slots, content, booking creation, confirmation, payment recovery, manage actions, reminders, contact capture, and anti-bot configuration.
- Booking lifecycle truth lives in `bookings`, `payments`, `booking_events`, `booking_side_effects`, and `booking_side_effect_attempts`.
- Technical observability depends on `api_logs` and `exception_logs`.
- Google Calendar controls availability reads and calendar event writes.
- Stripe or mock payments control checkout sessions, invoices, and payment success/failure signals.
- Resend or mock email controls confirmation, reminder, and expiration email delivery.
- Turnstile or mock antibot controls public form submission gates.

## Final Critique And Score

Score: `97/100`

Strengths:

- Captures the revised pay-later behavior explicitly instead of preserving the stale pre-2026-03-15 interpretation
- Covers both public and organizer surfaces
- Separates user-visible contract from implementation detail
- Includes the multi-user slot integrity behavior that materially affects real bookings

Remaining weakness:

- Coupon-driven effective-free paths and admin-authorized direct-confirm paths were added after the original March 15 pass, so older tests or notes may still reflect endpoint-shaped pay-now or pay-later assumptions rather than the newer shared post-pricing branch rules

## Follow-up Notes

- This freeze supersedes [expected_user_scenarios_freeze_illuminate_2026-03-12.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/expected_user_scenarios_freeze_illuminate_2026-03-12.md) where they conflict.
- The March 15 pay-later refinement is an intentional product change, not a regression.
- Effective-free coupon handling and admin-authorized direct confirmation are also intentional product changes and must be treated as shared-orchestration behavior, not endpoint-specific behavior.
- Future refactors must compare against this file first and treat the pay-later doc as governing detail for that subflow.

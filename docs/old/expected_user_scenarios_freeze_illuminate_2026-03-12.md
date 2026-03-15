# **ILLUMINATE — Frozen User Scenarios & Acceptance Contract**

**Version:** 2026-03-12  
**Purpose:** This document freezes the **user/business behavior** that must remain intact during refactors, migrations, schema redesigns, and internal implementation changes, unless an approved spec or design change explicitly overrides it. It is the contract for public flows, organizer flows, and their expected outcomes.

## **Scope**

Included:

* Public marketing and booking website  
* Organizer/admin tooling for the ILLUMINATE booking domain  
* Shared booking domain behavior across booking, payment, confirmation, self-service management, reminders, contact capture, and content operations

Excluded:

* Personal Assistant domain  
* Purely internal implementation structure, schemas, routing, storage, or orchestration details unless explicitly frozen elsewhere as business behavior

  ## **Contract Hierarchy**

This document freezes, in order of authority:

1. **User/business outcomes**  
2. **State rules and decision boundaries**  
3. **User-visible consequences**  
4. **Testing/traceability hints**

Anything labeled **Notes for implementation/testing** is **strictly FYI and non-contractual**. It exists only to help humans trace the current system during refactor/migration. It must never be treated as target design, preserved architecture, or an instruction for the new implementation.

---

# **1\. Discovery & Entry**

## **S01 — Visitor sees only currently available 1:1 offers and can enter the booking flow**

### **Why this scenario matters**

This is the main discovery path into paid and free 1:1 bookings. Refactors must not accidentally expose hidden offers, suppress active offers, or send users into the wrong booking flow.

### **Primary actor**

Visitor

### **Preconditions**

* At least zero or more session types exist  
* Some session types may be public/active and some may not  
* Public website is reachable

  ### **Main flow**

1. Visitor opens the sessions page.  
2. System displays only the currently public/active session offers.  
3. Visitor clicks the booking CTA on one offer.  
4. System routes the visitor into the correct booking flow for that offer.

   ### **Business contract**

* Only publicly available 1:1 offers may be shown on the public sessions page.  
* Hidden, draft, or otherwise non-public offers must not be shown.  
* The intro conversation must route into the intro booking flow.  
* Other exposed 1:1 offers must route into the paid session booking flow.  
* If no public offers are available, the page must show a clear “no sessions currently available” state rather than broken or misleading content.

  ### **Edge cases / rule boundaries**

* If all session types are non-public, visitor sees no bookable cards.  
* If an offer is visible, its CTA must lead into the matching booking type, not a generic or wrong one.  
* A temporary local/dev fallback is not part of frozen production behavior.

  ### **States / transitions affected**

* Session type public visibility only; no booking state created yet

  ### **User-visible outcomes**

* Visible cards only for currently available public offers  
* Correct “Book this session” entry path  
* Clear empty state when no public session types are available

  ### **Notes for implementation/testing**

* FYI only: current behavior is traced from public session-type content and booking-type routing on the site side.  
  ---

  ## **S02 — Visitor sees each ILLUMINATE Evening in the correct public registration state**

  ### **Why this scenario matters**

This is the main public entry into evening events. Users must be able to distinguish between bookable, sold-out, closed, and past events without ambiguity or false affordances.

### **Primary actor**

Visitor

### **Preconditions**

* Zero or more events exist  
* Events may differ by timing, status, capacity, and public booking availability

  ### **Main flow**

1. Visitor opens the evenings page.  
2. System displays upcoming and past evenings in their appropriate sections.  
3. For each visible event, system shows the correct public state and the correct available action.  
4. Visitor may proceed into booking, reminder signup, or simply inspect closed/past state.

   ### **Business contract**

* Upcoming and past evenings must be distinguishable.  
* A publicly bookable event must show a booking CTA.  
* A sold-out or no-longer-public event must not show the normal booking CTA.  
* A past event must not be presented as if it were still open for normal public registration.  
* Capacity/state display must be consistent with the event’s actual public registration state.

  ### **Edge cases / rule boundaries**

* “Sold out” and “booking closed” are not the same state and must not be conflated.  
* Past events must be separated from upcoming events.  
* A published event may still be unavailable for public booking due to timing or capacity rules.  
* If a reminder path is offered instead of booking, that substitution must be explicit.

  ### **States / transitions affected**

* Event visibility/render state only; no booking state created yet

  ### **User-visible outcomes**

* Event cards with visible state indicators  
* Correct CTA behavior per event  
* Past-event separation  
* No false booking CTA on closed/sold-out items

  ### **Notes for implementation/testing**

* FYI only: current system derives event render state from publication/timing/capacity rules.  
  ---

  ## **S03 — Visitor can join reminders for an evening that is sold out or closed to public booking**

  ### **Why this scenario matters**

This preserves interest capture when direct booking is unavailable. Refactors must not lose reminders, duplicate them chaotically, or pretend signup succeeded when no reminder intent was stored.

### **Primary actor**

Visitor

### **Preconditions**

* Visitor is viewing an evening for which reminder signup is offered instead of normal public booking  
* Reminder form is available

  ### **Main flow**

1. Visitor opens the reminder form from the evening card/state.  
2. Visitor submits the reminder form with email.  
3. System accepts the request.  
4. Visitor immediately sees success.

   ### **Business contract**

* Reminder signup must be available when the event exposes reminder capture instead of normal booking.  
* Success must be based on accepted reminder capture, not on any later outbound email.  
* The reminder success state must be immediate and user-visible.  
* The reminder must be associated with the submitted email.

  ### **Edge cases / rule boundaries**

* Duplicate reminder submissions for the same email must behave idempotently.  
* Allowed idempotent outcomes:  
  * existing reminder reused, or  
  * existing reminder refreshed/updated  
* In either case, user still sees success rather than a scary failure.  
* Reminder signup is not a booking and must not create a booking record by accident.

  ### **States / transitions affected**

* Reminder subscription persistence only  
* No booking/payment state transition

  ### **User-visible outcomes**

* Reminder success message  
* No fake booking confirmation  
* No payment step

  ### **Notes for implementation/testing**

* FYI only: current reminder flow is tied to the evenings reminder list rather than constituting a booking.  
  ---

  ## **S04 — Visitor can send a contact message and receive success once contact capture is accepted**

  ### **Why this scenario matters**

This is the public support/reach-out path. Refactors must preserve the distinction between “message accepted” and “email provider later succeeded,” otherwise users can lose trust or messages can silently disappear.

### **Primary actor**

Visitor

### **Preconditions**

* Visitor opens the contact page  
* Required fields are available  
* Anti-bot checks may apply

  ### **Main flow**

1. Visitor completes the contact form.  
2. Visitor submits the form.  
3. System validates required fields.  
4. If accepted, system stores the message.  
5. Visitor sees success.

   ### **Business contract**

* Required fields are first name, email, and message.  
* Success is based on accepted/stored contact capture, not guaranteed downstream notification delivery.  
* Invalid submissions must remain on the form with validation feedback.  
* Accepted contact submissions must persist the message and associate/update the client by email.

  ### **Edge cases / rule boundaries**

* Double-submit must not create duplicate messages.  
* If notification email later fails, already-accepted contact capture remains successful from the visitor’s perspective.  
* Validation errors must not yield false success.

  ### **States / transitions affected**

* Contact message persisted  
* Client record created or updated by email if applicable

  ### **User-visible outcomes**

* Validation feedback when invalid  
* Success panel/message after accepted submission  
* No dependence on later email delivery for success state

  ### **Notes for implementation/testing**

* FYI only: current public contact flow also triggers anti-bot verification and organizer notification attempts.  
  ---

  # **2\. Public Booking Creation**

  ## **S05 — Visitor can submit a free intro booking and is told to confirm it by email**

  ### **Why this scenario matters**

This flow preserves the free intro funnel and the email-confirmation gate. Refactors must not accidentally treat it as immediately confirmed, paid, or detached from confirmation-expiry behavior.

### **Primary actor**

Visitor

### **Preconditions**

* Intro session type is publicly available  
* Visitor enters the intro booking flow  
* A selectable slot is available

  ### **Main flow**

1. Visitor picks a date and available slot.  
2. Visitor enters required personal details.  
3. Visitor reviews and submits the booking.  
4. System creates the booking in pending state.  
5. System sends a confirmation email link.  
6. Visitor sees a success screen instructing them to confirm by email.

   ### **Business contract**

* The intro booking flow is free and must not require payment method selection.  
* Slot selection must be constrained to valid currently available slots.  
* Submission creates a booking that is not yet fully confirmed.  
* Visitor must be explicitly told that email confirmation is still required.  
* A confirmation link must be generated for the booking.

  ### **Edge cases / rule boundaries**

* A slot shown as available at selection time may become unavailable before final submit; the system must reject stale selection rather than double-book.  
* Email confirmation is required within its configured validity window; failure to confirm eventually leads to expiry according to booking-domain rules.  
* This flow must not create a payment row or Stripe checkout.

  ### **States / transitions affected**

* Booking created as:  
  * `booking_type = FREE`  
  * `current_status = PENDING`  
* Confirmation flow later determines:  
  * `PENDING -> CONFIRMED`, or  
  * `PENDING -> EXPIRED`

  ### **User-visible outcomes**

* Booking received success state  
* Explicit instruction to confirm by email  
* No payment step

  ### **Notes for implementation/testing**

* FYI only: current slot availability is derived from generated inventory filtered by calendar/busy/held rules.  
  ---

  ## **S06 — Visitor can submit a paid 1:1 booking with Pay Now and is redirected into Stripe checkout**

  ### **Why this scenario matters**

This is the primary paid-session purchase flow. Refactors must preserve booking creation, payment initiation, and the separation between pending booking state and eventual payment settlement.

### **Primary actor**

Visitor

### **Preconditions**

* Paid 1:1 session type is publicly available  
* A valid slot is available  
* Visitor chooses Pay Now

  ### **Main flow**

1. Visitor selects date and slot.  
2. Visitor enters required details.  
3. Visitor selects `Pay Now`.  
4. Visitor reviews and confirms.  
5. System creates a pending booking and payment intent state.  
6. System redirects the visitor to Stripe Checkout.

   ### **Business contract**

* A booking must be created before payment settlement is finalized.  
* The visible end of this flow is the redirect to Stripe checkout, not a local success page.  
* The booking remains pending until payment is actually settled/reconciled.  
* The system must associate the checkout with the booking.  
* A payment-verification/recovery path must remain possible after redirect.

  ### **Edge cases / rule boundaries**

* `SEND_PAYMENT_LINK` must not be created for the Pay Now flow; checkout is the payment path.  
* If slot availability is lost before submission completes, the system must refuse the booking rather than overbook.  
* Checkout initiation must not itself mark the booking confirmed.  
* Closing or abandoning checkout does not equal payment failure; it leaves a recoverable pending state until expiry or settlement rules decide otherwise.

  ### **States / transitions affected**

* Booking created as:  
  * `booking_type = PAY_NOW`  
  * `current_status = PENDING`  
* Payment created as:  
  * `status = PENDING`  
* Later transitions may include:  
  * payment `PENDING -> SUCCEEDED`  
  * booking `PENDING -> CONFIRMED`  
  * or expiry paths if unpaid in time

  ### **User-visible outcomes**

* Redirect to Stripe checkout  
* No in-page local “fully confirmed” message at submit time

  ### **Notes for implementation/testing**

* FYI only: current booking domain models paid booking creation separately from later `PAYMENT_SETTLED`.  
  ---

  ## **S07 — Visitor can submit a paid 1:1 session booking with Pay Later and is told to confirm it by email before payment**

  ### **Why this scenario matters**

This flow preserves the deliberate “confirm first, pay later” journey. Refactors must not collapse it into Pay Now, skip confirmation, or mis-sequence payment collection.

### **Primary actor**

Visitor

### **Preconditions**

* Paid 1:1 session type is publicly available  
* A valid slot is available  
* Visitor chooses `Pay Later`

  ### **Main flow**

1. Visitor selects date and slot.  
2. Visitor enters required details.  
3. Visitor selects `Pay Later`.  
4. Visitor reviews and confirms.  
5. System creates a pending booking.  
6. System sends a confirmation email link.  
7. Visitor sees success telling them email confirmation is still required before payment continues.

   ### **Business contract**

* Pay Later must create a booking immediately.  
* Payment is not collected at submission time.  
* A confirmation email link must be generated and sent.  
* Visitor must be explicitly told that email confirmation is required before the later payment path continues.  
* Payment link sending belongs after valid confirmation, not before.

  ### **Edge cases / rule boundaries**

* Pay Later must not behave like Pay Now.  
* Before confirmation, the booking remains pending and unconfirmed.  
* If confirmation expires, booking must expire rather than silently remaining indefinitely pending.  
* Slot contention rules still apply at booking creation.

  ### **States / transitions affected**

* Booking created as:  
  * `booking_type = PAY_LATER`  
  * `current_status = PENDING`  
* Later:  
  * confirmation may keep booking pending but advance payment path  
  * payment settlement later leads to `CONFIRMED`  
  * expiry may lead to `EXPIRED`

  ### **User-visible outcomes**

* Booking received success state  
* Explicit instruction to confirm by email  
* No immediate Stripe redirect from this branch

  ### **Notes for implementation/testing**

* FYI only: booking-domain rules separate email confirmation from later payment-link sending in Pay Later flows.  
  ---

  ## **S08 — Visitor can submit a free evening registration and is told to confirm it by email**

  ### **Why this scenario matters**

This preserves the free-event registration path and its confirmation gate. Refactors must not drop required fields, remove confirmation, or confuse free event registration with paid flows.

### **Primary actor**

Visitor

### **Preconditions**

* Event is publicly bookable  
* Event is free  
* Event registration form is available

  ### **Main flow**

1. Visitor opens the event booking flow.  
2. Visitor enters required details including phone.  
3. Visitor reviews and submits the registration.  
4. System creates a pending event booking.  
5. System sends a confirmation email link.  
6. Visitor sees success explaining email confirmation is still required.

   ### **Business contract**

* Free event registration must require the current required fields, including phone.  
* Registration creates a pending booking/registration rather than instantly confirming it.  
* Visitor must be told email confirmation is required.  
* A confirmation link must be generated and sent.

  ### **Edge cases / rule boundaries**

* This is free and must not redirect to Stripe.  
* Capacity/public-window rules must still gate whether visitor can start the flow.  
* A stale capacity situation at final submit must not create over-capacity confirmed registrations.

  ### **States / transitions affected**

* Booking created in pending state  
* Later confirmation may produce confirm/expire outcomes depending on domain rules

  ### **User-visible outcomes**

* Registration received success state  
* Explicit email-confirmation requirement  
* No payment step

  ### **Notes for implementation/testing**

* FYI only: current product requires phone for free evening registration.  
  ---

  ## **S09 — Visitor can submit a paid evening registration and is redirected into Stripe checkout**

  ### **Why this scenario matters**

This is the paid event-registration flow. Refactors must preserve the sequencing of registration creation, payment initiation, and later reconciliation, while still honoring event capacity/window rules.

### **Primary actor**

Visitor

### **Preconditions**

* Event is publicly bookable  
* Event is paid  
* Capacity and public-booking rules currently allow registration

  ### **Main flow**

1. Visitor opens the event booking flow.  
2. Visitor enters required details.  
3. Visitor reviews and submits.  
4. System creates a pending paid event booking.  
5. System redirects the visitor into Stripe checkout.

   ### **Business contract**

* Event public-bookability must be validated before allowing normal public registration.  
* A booking/registration must be created before payment settlement is finalized.  
* Paid evening registration ends visibly at Stripe checkout redirect, not local final confirmation.  
* Final confirmation depends on payment settlement/reconciliation, not mere checkout initiation.

  ### **Edge cases / rule boundaries**

* Public-bookability must account for timing, state, and capacity.  
* A checkout-started but unpaid registration remains pending until settled or expired.  
* Capacity must not be overrun by race conditions at the last available spot.

  ### **States / transitions affected**

* Pending paid event booking created  
* Payment pending created  
* Later settlement may confirm; failure/expiry rules may expire or fail payment

  ### **User-visible outcomes**

* Redirect to Stripe checkout  
* No premature “fully confirmed” message at submit time

  ### **Notes for implementation/testing**

* FYI only: this flow follows the same booking/payment separation principle as paid 1:1 Pay Now.  
  ---

  ## **S10 — Visitor with a valid late-access link can still register for a closed evening**

  ### **Why this scenario matters**

This is a privileged public exception flow. Refactors must preserve the difference between normal public closure and allowed access via valid late-access token, without accidentally making all closed events bookable again.

### **Primary actor**

Visitor with a valid late-access link

### **Preconditions**

* Event exists  
* Normal public booking is no longer available  
* Visitor has a valid event-specific late-access link/token  
* Event is still within the configured late-access validity window

  ### **Main flow**

1. Visitor opens the late-access link.  
2. System validates the late-access token and event eligibility.  
3. Visitor completes the event registration flow.  
4. System proceeds according to the event’s free or paid registration path.

   ### **Business contract**

* A valid late-access link may bypass the normal public booking cutoff for that specific event.  
* Late access must still require a valid event and valid late-access token.  
* The resulting registration must obey the same free/paid branch behavior as the normal event flow.  
* Late access must not grant access beyond its configured validity window.

  ### **Edge cases / rule boundaries**

* Invalid, expired, or revoked late-access links must not allow booking.  
* Late access bypasses the normal public cutoff, but not arbitrary event existence validation.  
* If the event’s actual registration path is paid, late access still leads to checkout; if free, it still follows the free confirmation path.  
* Rotated late-access links invalidate the previous active token.

  ### **States / transitions affected**

* Same booking transitions as corresponding free/paid event path  
* Separate late-access token validity lifecycle

  ### **User-visible outcomes**

* Working late-access registration when link is valid  
* Rejection/invalid state when link is not valid  
* Success or Stripe redirect according to event payment type

  ### **Notes for implementation/testing**

* FYI only: current organizer tooling can rotate late-access links and revoke prior active ones.  
  ---

  # **3\. Confirmation, Payment Recovery & Self-Service Management**

  ## **S11 — Visitor can open a confirmation link and be sent to the next valid public action**

  ### **Why this scenario matters**

This is the bridge between booking submission and the correct next step. Refactors must preserve not just token validation, but the business logic that decides whether the user should pay, manage, or see expiry/fallback behavior.

### **Primary actor**

Visitor

### **Preconditions**

* Visitor has a booking confirmation link  
* Link token is either valid or expired/invalid

  ### **Main flow**

1. Visitor opens the confirmation link.  
2. System validates the token.  
3. If valid, system applies the booking confirmation logic.  
4. System shows the confirmed state and the correct next action.  
5. If expired/invalid, system shows an explicit expired/invalid state.

   ### **Business contract**

* Confirmation links must resolve to the next valid public action, not merely to a generic success page.  
* Possible next actions include payment, manage booking, or homepage/site fallback depending on current booking state.  
* Expired confirmation links must resolve into an explicit expiry/failure state.  
* Confirmation logic must be consistent with booking-type rules.

  ### **Edge cases / rule boundaries**

* Pay Later confirmation may advance the user toward payment rather than immediate confirmed-manage state.  
* For already-complete paths, confirmation may lead to manage or a safe fallback.  
* Confirmation link usage must not produce duplicate contradictory booking transitions.

  ### **States / transitions affected**

* Example transitions:  
  * FREE: `PENDING -> CONFIRMED` or `PENDING -> EXPIRED`  
  * PAY\_LATER: may remain `PENDING` until payment settles, or expire  
* Next-action resolution depends on current booking/payment state

  ### **User-visible outcomes**

* Success card with next CTA when valid  
* Explicit expired/invalid state when not valid  
* No “dead end” after confirmation

  ### **Notes for implementation/testing**

* FYI only: current product uses confirmation-page resolution logic rather than forcing the user to wait for separate email sequences.  
  ---

  ## **S12 — Visitor can recover from a completed checkout through the payment-success path even if email is delayed**

  ### **Why this scenario matters**

This is the rescue path when Stripe returns before email or background reconciliation is fully visible to the user. Refactors must preserve progress, reduce support friction, and avoid leaving a paid user in limbo.

### **Primary actor**

Visitor returning from Stripe

### **Preconditions**

* Visitor returns from Stripe with a valid payment session identifier  
* Payment may already be settled or may still be reconciling

  ### **Main flow**

1. Visitor lands on the payment-success page from Stripe.  
2. System resolves the Stripe session to the booking/payment context.  
3. System determines the current public-safe next action.  
4. Visitor sees a recovery card/status and a CTA, usually to manage booking.

   ### **Business contract**

* The payment-success path must let the user continue even if email is delayed.  
* The next action must be derived from the Stripe session and booking context, not from email arrival.  
* The page must distinguish between “payment/booking fully ready” and “still finalizing” states when relevant.  
* The flow must not require the user to manually search for a link elsewhere.

  ### **Edge cases / rule boundaries**

* If payment is settled but reconciliation is still finalizing, user must see a safe recovery state rather than a generic failure.  
* If the payment session is invalid/unresolvable, user must see a controlled error state.  
* This flow must tolerate email delay.  
* Successful payment after partial internal failure must still be recoverable through later reconciliation/webhook logic.

  ### **States / transitions affected**

* Payment may move to `SUCCEEDED`  
* Booking may already be `CONFIRMED` or may confirm moments later through reconciliation  
* Public-safe next-action resolution depends on current states

  ### **User-visible outcomes**

* Payment recovery card  
* Appropriate CTA such as `Manage booking`  
* Controlled “still finalizing” or load-error behavior when needed

  ### **Notes for implementation/testing**

* FYI only: current behavior resolves payment session to booking to determine next public action.  
  ---

  ## **S13 — Visitor can open a manage link and see the current booking state plus only the allowed actions**

  ### **Why this scenario matters**

The manage page is the self-service control center. Refactors must preserve policy gating, state visibility, and the difference between what is viewable and what is still editable.

### **Primary actor**

Visitor

### **Preconditions**

* Visitor has a valid manage link/token, or an invalid/expired one  
* Booking exists

  ### **Main flow**

1. Visitor opens the manage link.  
2. System resolves the token to the booking.  
3. System loads current booking/event details and evaluates policy.  
4. System shows the current state and only the actions still allowed.

   ### **Business contract**

* A valid manage link must open the correct booking.  
* The manage page must show current booking/event details and current policy state.  
* Only currently allowed self-service actions may be shown.  
* Invalid or expired manage links must resolve into a dedicated load-error state rather than blank/broken behavior.  
* Event bookings do not expose self-service rescheduling; eligible session bookings may.

  ### **Edge cases / rule boundaries**

* Policy evaluation must honor lock-window rules near start time.  
* If no self-service action remains allowed, the manage view may still be viewable but must not expose forbidden controls.  
* Invalid/expired token must not leak booking details.  
* Manage access must reflect current booking status, not stale assumptions.

  ### **States / transitions affected**

* No state change just by loading the manage view  
* Policy reads current booking/payment/time context

  ### **User-visible outcomes**

* Detail view for the specific booking  
* Correctly gated action set:  
  * reschedule  
  * cancel  
  * both  
  * neither  
* Policy/lock message when relevant  
* Explicit load-error state when token invalid

  ### **Notes for implementation/testing**

* FYI only: current product distinguishes policy block and lock-window messaging on the manage page.  
  ---

  ## **S14 — Visitor can reschedule an eligible 1:1 booking to a new slot from the manage flow**

  ### **Why this scenario matters**

Rescheduling is a high-value self-service operation. Refactors must preserve the rules around eligibility, slot validation, and the fact that this is a modification of an existing booking, not creation of a detached new public booking.

### **Primary actor**

Visitor, or organizer using privileged access where applicable

### **Preconditions**

* Booking is a 1:1 booking  
* Booking is currently eligible for self-service reschedule, or privileged bypass applies  
* A new slot is available

  ### **Main flow**

1. Visitor opens `Reschedule` from manage.  
2. Visitor picks a new slot.  
3. Visitor reviews and confirms the new time.  
4. System validates slot availability.  
5. System saves the new time.  
6. Visitor sees reschedule success with the new time.

   ### **Business contract**

* Reschedule is available only for eligible 1:1 bookings.  
* Event registrations do not expose self-service reschedule.  
* Rescheduling must validate the newly selected slot at confirmation time.  
* The resulting saved state must reflect the new session time.  
* The user must end on a reschedule-success state showing the new saved time.

  ### **Edge cases / rule boundaries**

* If the new slot becomes unavailable before final confirmation, reschedule must fail cleanly rather than overbook.  
* Normal lock-window rules may block self-service reschedule.  
* A privileged admin-bypass access path may override the normal lock window where supported.  
* Rescheduling must not accidentally create duplicate live bookings for the same appointment intent.  
* Analytics/audit should preserve that a reschedule happened, including old/new timing context.

  ### **States / transitions affected**

* Booking remains effectively active/confirmed after successful reschedule  
* Event/audit transition:  
  * `BOOKING_RESCHEDULED`  
* Booking time fields change  
* Calendar update side effects may be triggered downstream

  ### **User-visible outcomes**

* Slot picker with current contact context retained  
* Failure if chosen slot no longer available  
* Reschedule-success state showing new time

  ### **Notes for implementation/testing**

* FYI only: current model records reschedule as a domain event and updates the existing booking timing.  
  ---

  ## **S15 — Visitor can cancel an eligible booking from the manage flow and see the canceled end state**

  ### **Why this scenario matters**

Cancellation is a core self-service safeguard. Refactors must preserve eligibility rules, the terminal canceled state, and the distinction between paid and non-paid downstream consequences.

### **Primary actor**

Visitor, or organizer using privileged access where applicable

### **Preconditions**

* Visitor has valid manage access  
* Booking is still eligible for self-service cancel, or privileged bypass applies

  ### **Main flow**

1. Visitor opens `Cancel booking` from manage.  
2. Visitor confirms the cancellation.  
3. System processes cancellation.  
4. Visitor lands on the canceled end state.

   ### **Business contract**

* Cancellation must only be available when current policy allows it.  
* Once cancellation succeeds, the booking must enter canceled state.  
* The post-cancel user experience must be terminal for that booking state, not a misleading editable view.  
* Paid and non-paid bookings may have different downstream messaging/policy, but the cancellation outcome must be clear.

  ### **Edge cases / rule boundaries**

* If booking is inside the lock window and no bypass applies, self-service cancel must not be exposed.  
* Cancel must not remain available after successful cancellation.  
* Paid booking cancellation may trigger refund-related downstream handling where policy allows; absence of immediate refund completion does not negate the canceled booking state.  
* Canceling an already canceled booking must behave idempotently and must not create nonsense transitions.

  ### **States / transitions affected**

* Booking:  
  * `PENDING -> CANCELED`, or  
  * `CONFIRMED -> CANCELED`  
* Possible payment aftermath:  
  * `SUCCEEDED -> REFUNDED` later when applicable  
* Cancellation confirmation side effects may be triggered

  ### **User-visible outcomes**

* Cancel-confirm dialog  
* Canceled confirmation screen/end state  
* No continued editable self-service controls for the canceled booking

  ### **Notes for implementation/testing**

* FYI only: current cancellation flow differentiates paid/non-paid warning language and may trigger refund-related downstream processes.  
  ---

  # **4\. Organizer Access & Booking Operations**

  ## **S16 — Organizer must be signed in before using organizer tools**

  ### **Why this scenario matters**

This is the guardrail that protects organizer-only data and actions. Refactors must not accidentally expose organizer screens publicly or replace protected behavior with partial broken loading.

### **Primary actor**

Organizer

### **Preconditions**

* Organizer opens an organizer page  
* Organizer may or may not have valid admin access

  ### **Main flow**

1. Organizer opens an organizer page.  
2. If admin access is missing, system blocks protected data.  
3. System shows sign-in-required state and login path.  
4. After valid sign-in, organizer can retry and proceed.

   ### **Business contract**

* Organizer tools must not be usable without valid admin access.  
* Missing auth must yield a sign-in-required state, not silent partial failure.  
* Protected data must remain blocked until access is valid.  
* The sign-in gate applies across organizer booking/content/contact tooling.

  ### **Edge cases / rule boundaries**

* Expired admin access during organizer use must degrade into controlled auth-required behavior.  
* Current page context should remain recoverable for retry after login where possible.  
* Public users must never see organizer data by direct URL guesswork.

  ### **States / transitions affected**

* Auth/access state only  
* No booking state transition

  ### **User-visible outcomes**

* Sign-in-required banner/state  
* Login path  
* Protected data withheld until valid access

  ### **Notes for implementation/testing**

* FYI only: current organizer access relies on access protection in front of backend calls rather than a custom app login form.  
  ---

  ## **S17 — Organizer can load, filter, and edit booking records from the bookings workbench**

  ### **Why this scenario matters**

This is the day-to-day organizer operational surface. Refactors must preserve the ability to inspect and correct booking/client data without accidentally broadening or corrupting lifecycle rules.

### **Primary actor**

Organizer

### **Preconditions**

* Organizer is signed in  
* Bookings exist, or empty-state behavior is available

  ### **Main flow**

1. Organizer opens the bookings page.  
2. Organizer applies source/type/date/client filters as needed.  
3. System loads matching booking rows.  
4. Organizer opens a booking for edit.  
5. Organizer edits allowed fields and saves.  
6. System refreshes the visible dataset.

   ### **Business contract**

* Organizer must be able to load bookings with the supported filtering modes.  
* Organizer must be able to inspect and edit the current allowed operational fields.  
* Saving valid edits must refresh the data shown in the same workbench context.  
* Client and booking edits must persist to the appropriate domain records.

  ### **Edge cases / rule boundaries**

* Filters must distinguish event-source from session-source querying behavior.  
* Invalid edits must not silently corrupt state.  
* Admin editing power does not authorize impossible lifecycle combinations.  
* Empty results must produce a usable empty state rather than a broken table.

  ### **States / transitions affected**

* Client fields may change  
* Booking notes/status may change  
* Any admin status change must still obey the global state rules below

  ### **User-visible outcomes**

* Filterable booking dataset  
* Edit modal/details view  
* Saved changes reflected after refresh

  ### **Notes for implementation/testing**

* FYI only: current organizer workbench supports editing booking notes/status plus core client fields.  
  ---

  ## **S18 — Organizer can generate privileged booking links and rotate an evening late-access link**

  ### **Why this scenario matters**

These are operational utility tools that support customer assistance and event exceptions. Refactors must preserve privileged/admin-safe access versus client-safe access and must preserve link rotation semantics for late access.

### **Primary actor**

Organizer

### **Preconditions**

* Organizer is signed in  
* Relevant booking or event context is selected

  ### **Main flow**

1. Organizer opens the relevant booking or event context.  
2. Organizer generates/copies:  
   * privileged admin manage link, or  
   * client-safe manage link, or  
   * rotated late-access event link  
3. System returns the requested link and visible result.

   ### **Business contract**

* Organizer must be able to generate a privileged operational manage link for internal use.  
* Organizer must be able to generate a client-safe manage link for external sharing.  
* Organizer must be able to rotate the active late-access link for an event.  
* Rotating late access must revoke/replace the prior active late-access link for that event.

  ### **Edge cases / rule boundaries**

* Privileged link and client-safe link must not be equivalent in capability.  
* Rotated late-access links must invalidate the previous active link.  
* A late-access link must carry an expiry/validity boundary.  
* Copy/generation success must not expose hidden secrets in a broken or mixed-up form.

  ### **States / transitions affected**

* Manage-token generation/access  
* Late-access token revocation/replacement lifecycle

  ### **User-visible outcomes**

* Copyable/manageable link result  
* Visible late-access expiry information where applicable

  ### **Notes for implementation/testing**

* FYI only: current organizer tooling supports both admin-bypass manage access and client-safe manage access.  
  ---

  ## **S19 — Organizer can review inbound contact messages with filters, sorting, and full-message view**

  ### **Why this scenario matters**

This preserves the organizer’s ability to handle inbound leads/support messages. Refactors must not detach contact messages from their client context or reduce the page to unreadable snippets only.

### **Primary actor**

Organizer

### **Preconditions**

* Organizer is signed in  
* Contact messages may exist

  ### **Main flow**

1. Organizer opens the contact messages page.  
2. Organizer filters and/or sorts the dataset.  
3. Organizer opens a selected message.  
4. System shows the full message content.

   ### **Business contract**

* Organizer must be able to view stored contact messages.  
* Organizer must be able to filter and sort the dataset.  
* Organizer must be able to open the full content of a selected message.  
* This page is for review, not necessarily full reply workflow.

  ### **Edge cases / rule boundaries**

* Long message bodies may appear compact in table view but must be fully readable on open.  
* Empty search results must remain usable.  
* Contact messages must remain tied to the captured inbound record, not reconstructed loosely from email logs.

  ### **States / transitions affected**

* Read-only review flow; no booking/payment transition

  ### **User-visible outcomes**

* Filterable/sortable message list  
* Full-message modal/view

  ### **Notes for implementation/testing**

* FYI only: current filtering supports date, client, and free-text style narrowing.  
  ---

  # **5\. Organizer Content & Offer Management**

  ## **S20 — Organizer can create or edit session types, including image-backed content fields**

  ### **Why this scenario matters**

Session types are first-class public offer content. Refactors must preserve organizer control over session metadata and public exposure without freezing the storage architecture behind media.

### **Primary actor**

Organizer

### **Preconditions**

* Organizer is signed in  
* Session type management page is accessible

  ### **Main flow**

1. Organizer opens the session types management area.  
2. Organizer creates a new session type or opens an existing one.  
3. Organizer edits content and operational fields.  
4. Organizer optionally uploads/associates an image.  
5. Organizer saves.  
6. System refreshes the visible list.

   ### **Business contract**

* Organizer must be able to create a new session type.  
* Organizer must be able to edit an existing session type.  
* Organizer must be able to manage descriptive fields, pricing/duration/sort/content status, and image-backed content fields.  
* Public visibility of session types must continue to depend on their intended status/public exposure rules.

  ### **Edge cases / rule boundaries**

* Draft/hidden session types must not automatically appear publicly.  
* Image upload/association must not be treated as the contract for a specific storage backend.  
* Save failures must not present stale success.  
* Missing image should not block non-image content edits unless explicitly required.

  ### **States / transitions affected**

* Session type content/status changes  
* Public exposure rules for discovery scenario S01

  ### **User-visible outcomes**

* Editable session type form  
* Refreshed list after save  
* Image-backed content visible when associated

  ### **Notes for implementation/testing**

* FYI only: current product stores image references on the session type record; storage provider details are non-contractual here.  
  ---

  ## **S21 — Organizer can edit existing events, including capacity, payment, timing, and image-backed content fields**

  ### **Why this scenario matters**

Event editing controls the public evenings experience and the operational rules around registration. Refactors must preserve organizer control over these properties while avoiding accidental over-freezing of current CMS mechanics.

### **Primary actor**

Organizer

### **Preconditions**

* Organizer is signed in  
* Existing event exists

  ### **Main flow**

1. Organizer opens the events management area.  
2. Organizer selects an existing event.  
3. Organizer edits content and operational fields.  
4. Organizer optionally uploads/associates an image.  
5. Organizer saves.  
6. System refreshes the visible event list.

   ### **Business contract**

* Organizer must be able to edit an existing event.  
* Organizer must be able to edit operational event fields including timing, capacity, publication/payment-related values, and key descriptive/content fields.  
* Saved event changes must feed the same public event behavior used by the evenings page and event booking flows.  
* Media association is supported, but the underlying media storage architecture is not frozen here.

  ### **Edge cases / rule boundaries**

* Current contract freezes editing of existing events, not necessarily creation of new events from this page.  
* Capacity changes must affect later public/render/bookability behavior consistently.  
* Paid-event flags and prices must remain logically consistent.  
* Save failures must not present stale success.  
* Image upload/association must remain optional for non-image edits unless explicitly required.

  ### **States / transitions affected**

* Event content/status/timing/capacity/payment-property changes  
* These changes influence S02, S08, S09, and S10 behavior

  ### **User-visible outcomes**

* Editable event form  
* Refreshed event list after save  
* Updated public behavior after save/refresh according to new values

  ### **Notes for implementation/testing**

* FYI only: current system supports editing existing events from organizer content tooling; current media-reference fields are not frozen as architecture.  
  ---

  # **6\. Global State Rules**

  ## **6.1 Booking types**

* `FREE`  
* `PAY_NOW`  
* `PAY_LATER`

  ## **6.2 Booking lifecycle states**

* `PENDING`  
* `CONFIRMED`  
* `CANCELED`  
* `EXPIRED`  
* `COMPLETED`  
* `NO_SHOW`

  ## **6.3 Payment states**

* `PENDING`  
* `SUCCEEDED`  
* `FAILED`  
* `REFUNDED`

  ## **6.4 Core state principles**

* Booking lifecycle and payment lifecycle are separate and must remain logically separate.  
* A booking being created does not imply payment settled.  
* Payment settled does not retroactively erase the need for correct booking transition logic.  
* For paid bookings, true confirmation depends on payment settlement according to the booking-domain orchestration rules.  
* For free bookings, confirmation depends on valid confirmation flow rather than payment.

  ## **6.5 Canonical transition rules**

* Public submission creates a booking in `PENDING`.  
* `PAY_NOW` creates payment state `PENDING` and initiates checkout.  
* `FREE` confirmation can produce:  
  * `PENDING -> CONFIRMED`  
  * `PENDING -> EXPIRED`  
* `PAY_LATER` confirmation may keep booking `PENDING` until payment later settles, or may lead to `EXPIRED` if confirmation/payment windows lapse.  
* `PAYMENT_SETTLED` is the fact that drives paid booking confirmation.  
* Cancellation can transition an eligible booking from `PENDING` or `CONFIRMED` to `CANCELED`.  
* Refund completion does not undo cancellation; it changes payment state to `REFUNDED`.  
* Expiration is a booking event/result, not a fake UI decoration.

  ## **6.6 Forbidden or nonsensical combinations**

These must not be introduced by refactor logic or organizer editing:

* Treating checkout initiation as final confirmation  
* Treating reminder signup as a booking  
* Treating past events as publicly bookable  
* Treating expired tokens as valid access  
* Generating `SEND_PAYMENT_LINK` in Pay Now flow  
* Conflating booking state and payment state into a single truth  
* Creating impossible admin-edited contradictions such as “fully operationally confirmed” while preserving incompatible failed-payment reality without explicit business rule support  
  ---

  # **7\. Cross-Cutting Edge Cases**

  ## **7.1 Duplicate submit / retry**

* Public double-submit must not create duplicate business records where idempotent handling is appropriate.  
* Contact and reminder flows should behave idempotently for rapid repeat submission.  
* Cancellation of an already canceled booking should not create nonsense duplicate outcomes.

  ## **7.2 Slot and capacity race conditions**

* Two users must not both successfully take the same last slot/capacity unit.  
* Final validation at submission/confirmation time must defeat stale availability views.

  ## **7.3 Expired or stale links**

* Expired confirmation links must show explicit expired state.  
* Invalid or expired manage links must show explicit load-error state.  
* Rotated late-access links must invalidate prior active access.

  ## **7.4 Passed-event restrictions**

* Past events must not be treated as normal public-bookable items.  
* After event/session start passes, self-service actions may be restricted according to policy and must not remain exposed contrary to policy.

  ## **7.5 Payment reconciliation and delayed visibility**

* A successful payment can return the user before all user-facing downstream signals are complete.  
* The system must support safe recovery via payment-success flow even if email is delayed.  
* Webhook or verification-based reconciliation must be able to repair partial internal failure after successful payment.

  ## **7.6 Success semantics**

* Public success must mean the business input was accepted, not that every downstream provider already succeeded.  
* Contact success is based on accepted/stored message capture.  
* Reminder success is based on accepted reminder capture.  
* Booking success screens must accurately describe whether the booking is still pending confirmation/payment.

  ## **7.7 Admin editing boundaries**

* Organizer tools may correct operational data, but must not create impossible business truth.  
* Admin access and client-safe access must remain distinct.  
* FYI-only implementation details must never be misread as preserved behavior requirements.  
  ---

  # **8\. Acceptance Checklist**

A refactor/migration passes this contract when all of the following remain true:

* Public sessions page shows only currently public 1:1 offers and routes each into the correct booking flow.  
* Evenings page distinguishes upcoming, sold-out/closed, and past states correctly.  
* Reminder signup still works and behaves idempotently.  
* Contact form still stores accepted messages and shows success independent of later email delivery.  
* Free intro booking still creates pending booking and requires email confirmation.  
* Paid Pay Now session booking still redirects to Stripe and does not prematurely claim full confirmation.  
* Pay Later session booking still requires email confirmation before later payment continuation.  
* Free evening registration still requires confirmation and preserves required-field behavior.  
* Paid evening registration still redirects to Stripe under correct public-bookability checks.  
* Valid late-access links still allow eligible closed-evening access, while invalid/rotated/expired links do not.  
* Confirmation link still resolves to the correct next public action or explicit expiry state.  
* Payment-success path still allows recovery even when email is delayed.  
* Manage link still shows only the actions currently allowed.  
* Eligible session bookings can still be rescheduled safely.  
* Eligible bookings can still be canceled into a clear canceled end state.  
* Organizer access is still protected by sign-in requirements.  
* Organizer can still load/filter/edit bookings.  
* Organizer can still generate privileged/client-safe links and rotate late-access links.  
* Organizer can still review contact messages.  
* Organizer can still create/edit session types.  
* Organizer can still edit existing events.  
* Booking/payment state boundaries remain logically consistent with the final booking-domain model.  
  ---

  # **9\. Glossary Seeds**

**Session type**  
A 1:1 offer that can appear on the public sessions page and lead into a booking flow.

**Event / ILLUMINATE Evening**  
A group gathering with timing, capacity, and public registration behavior.

**Reminder signup**  
A non-booking request by which a visitor asks to be notified or remembered for future availability.

**Booking**  
The current operational record of a reservation/registration attempt or commitment.

**Booking type**  
How the booking handles money: free, pay now, or pay later.

**Booking status**  
The current lifecycle state of the booking itself, such as pending, confirmed, canceled, or expired.

**Payment status**  
The current financial state of the related payment, such as pending, succeeded, failed, or refunded.

**Confirmation link**  
A link sent by email that validates the booking and routes the visitor to the correct next public step.

**Manage link**  
A link that lets the visitor view and, where allowed, self-manage a booking.

**Late-access link**  
A special event-specific link that can bypass the normal public booking cutoff while it remains valid.

**Lock window**  
The time-based policy boundary after which normal self-service actions such as cancel or reschedule may no longer be allowed.

**Organizer / admin**  
The internal operator using protected tools to manage bookings, content, contact messages, and privileged links.

**Payment-success recovery path**  
The page/flow that lets a returning Stripe user continue safely even if email or downstream updates are delayed.

---

# **10\. Final Note**

This document freezes **behavior**, **state meaning**, and **expected outcomes**. It does **not** freeze current code structure, schema shape, routes, storage providers, integration internals, or orchestration implementation except where another approved spec explicitly says so. For refactors and migrations, that distinction is the whole ball game.


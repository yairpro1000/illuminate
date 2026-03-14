# P4 Manual Test Status 2026-03-14

Rule used here:
- `1` means the scenario was explicitly covered and passed in this P4 automated run.
- `0` means not yet explicitly covered/passed in this P4 automated run.
- This is intentionally conservative.

## Done
- `T01` Open sessions page
- `T02` Open intro booking from sessions page
- `T03` Open paid 1:1 booking from sessions page
- `T04` Open evenings page
- `T05` Sold out evening is not normally bookable
- `T07` Reminder signup on unavailable evening
- `T08` Contact form valid submit
- `T09` Contact form invalid submit
- `T10` Book free intro
- `T11` Book paid 1:1 with Pay Now
- `T12` Book paid 1:1 with Pay Later
- `T13` Book free evening
- `T14` Book paid evening
- `T16` Confirm free intro from email link
- `T17` Confirm Pay Later booking from email link
- `T18` Stripe success returns to recovery path
- `T19` Abandon Stripe checkout
- `T21` Open valid manage link
- `T22` Open invalid manage link
- `T23` Reschedule eligible 1:1 booking
- `T24` Cancel eligible booking
- `T25` Event booking cannot self-reschedule
- `T29` Edit booking/client data in admin
- `T28` View/filter bookings in admin
- `T30` Generate client-safe manage link
- `T31` Generate privileged admin link
- `T32` Rotate late-access link
- `T33` View contact messages
- `T34` Create session type
- `T35` Edit session type incl. image-backed content
- `T36` Edit existing event incl. capacity/timing/content
- `T37` Booked slot disappears and returns after cancel
- `T38` Multi-user race at final review shows clean slot-taken message

## Not Done Yet
- `T06` Closed evening is not normally bookable
- `T15` Late-access evening booking works
- `T20` Expired confirmation link
- `T26` Locked booking cannot self-manage restricted actions
- `T27` Organizer pages require sign-in

## Notes
- `T01`, `T04`, `T05`, `T07`, `T09`, `T12`, `T17`, `T19`, `T22`, and `T25` are now covered on both desktop and mobile.
- `T28`, `T30`, `T31`, `T32`, `T33`, `T34`, `T35`, and `T36` are now covered on desktop admin.
- `T27` is currently not meaningful in the deployed pre-prod environment because admin is intentionally unprotected during this phase.
- `T29` was covered as an admin edit/save/persist sanity path, not as a full admin CRUD sweep.
- `T38` is now green against the live backend with the DB overlap guard plus clean `409` conflict handling.

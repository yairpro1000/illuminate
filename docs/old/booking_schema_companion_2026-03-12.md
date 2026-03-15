March 12, 2026

---

# **Booking-Centric Schema (Final Model)**

This document describes the **final booking-domain schema** and the philosophy behind it.

The schema is designed so that:

* **Events** describe **facts that happened**  
* **Side effects** describe **actions that must be executed**  
* **Verification side effects** may discover **new events**  
* **Booking lifecycle** and **payment lifecycle** are kept separate

Cron is **not** a domain actor. It only wakes the system to execute due verification side effects.

---

# **1\. Core Tables**

## **`clients`**

Stores people who interact with the system.

id  
first\_name  
last\_name  
email  
phone  
created\_at  
updated\_at

Unique constraint:

lower(email)

---

# **2\. Session Types**

## **`session_types`**

Defines the types of sessions that can be booked.

id  
title  
slug  
short\_description  
description  
duration\_minutes  
price  
currency  
status  
sort\_order  
image\_key  
drive\_file\_id  
image\_alt  
created\_at  
updated\_at

### **Status values**

DRAFT  
ACTIVE  
HIDDEN

---

# **3\. Events (Group gatherings)**

## **`events`**

Represents scheduled gatherings.

id  
slug  
title  
description  
starts\_at  
ends\_at  
timezone  
location\_name  
address\_line  
maps\_url  
is\_paid  
price\_per\_person\_cents  
currency  
capacity  
status  
image\_key  
drive\_file\_id  
image\_alt  
whatsapp\_group\_invite\_url  
created\_at  
updated\_at

### **Event Status**

DRAFT  
PUBLISHED  
CANCELED  
SOLD\_OUT

### **Constraints**

ends\_at \> starts\_at

Paid events require a price.

---

# **4\. Bookings**

## **`bookings`**

Represents a booking for either a **session** or an **event**.

id  
client\_id  
event\_id  
session\_type\_id  
booking\_type  
starts\_at  
ends\_at  
timezone  
google\_event\_id  
meeting\_provider  
meeting\_link  
address\_line  
maps\_url  
current\_status  
notes  
created\_at  
updated\_at

Exactly **one** of:

event\_id  
session\_type\_id

must be present.

---

## **Booking Type**

Determines how payment is handled.

FREE  
PAY\_NOW  
PAY\_LATER

---

## **Booking Lifecycle Status**

PENDING  
CONFIRMED  
CANCELED  
EXPIRED  
COMPLETED  
NO\_SHOW

Important principle:

Booking lifecycle is **independent** from payment lifecycle.

---

# **5\. Payments**

## **`payments`**

Represents the financial transaction for a booking.

id  
booking\_id  
provider  
provider\_payment\_id  
amount\_cents  
currency  
status  
checkout\_url  
invoice\_url  
raw\_payload  
paid\_at  
created\_at  
updated\_at

### **Payment Status**

PENDING  
SUCCEEDED  
FAILED  
REFUNDED

---

# **6\. Booking Events**

## **`booking_events`**

Records **facts that happened** in the booking lifecycle.

id  
booking\_id  
event\_type  
source  
payload  
created\_at

---

## **Event Source**

Who triggered the chain.

PUBLIC\_UI  
ADMIN\_UI  
SYSTEM  
WEBHOOK

Cron jobs are **not** a source.

Cron only wakes the system to process verification side effects.

---

## **Event Types**

Only **facts that may trigger work** appear here.

BOOKING\_FORM\_SUBMITTED  
BOOKING\_RESCHEDULED  
BOOKING\_CANCELED  
BOOKING\_EXPIRED  
PAYMENT\_SETTLED  
REFUND\_COMPLETED

Events like:

BOOKING\_CONFIRMED  
BOOKING\_COMPLETED  
BOOKING\_NO\_SHOW

are **booking states**, not events.

---

# **7\. Side Effects**

## **`booking_side_effects`**

Represents actions that must be executed.

These actions may target:

* external providers  
* internal verification logic

id  
booking\_event\_id  
source  
effect\_intent  
status  
expires\_at  
max\_attempts  
created\_at  
updated\_at

---

## **Side Effect Source**

Which system must execute the action.

EMAIL  
CALENDAR  
PAYMENT  
WHATSAPP  
SYSTEM

---

## **Side Effect Status**

PENDING  
SUCCESS  
FAILED  
DEAD

Meaning:

| Status | Meaning |
| ----- | ----- |
| PENDING | waiting to be executed |
| SUCCESS | action executed successfully |
| FAILED | last attempt failed but retry possible |
| DEAD | no more retries |

---

## **Side Effect Intents**

Actions that must be performed.

SEND\_BOOKING\_CONFIRMATION\_REQUEST  
SEND\_BOOKING\_CONFIRMATION  
SEND\_PAYMENT\_LINK  
SEND\_PAYMENT\_REMINDER  
SEND\_BOOKING\_CANCELLATION\_CONFIRMATION  
SEND\_BOOKING\_EXPIRATION\_NOTIFICATION  
SEND\_EVENT\_REMINDER

CREATE\_STRIPE\_CHECKOUT  
VERIFY\_EMAIL\_CONFIRMATION  
VERIFY\_STRIPE\_PAYMENT  
CREATE\_STRIPE\_REFUND

RESERVE\_CALENDAR\_SLOT  
UPDATE\_CALENDAR\_SLOT  
CANCEL\_CALENDAR\_SLOT

---

# **8\. Verification Side Effects**

Two side effects represent **internal verification logic**:

VERIFY\_EMAIL\_CONFIRMATION  
VERIFY\_STRIPE\_PAYMENT

These are **not provider calls**.

They are **internal system checks**.

Execution may result in:

* emitting a new event  
* updating booking/payment state  
* creating further side effects

Example:

VERIFY\_EMAIL\_CONFIRMATION

may produce:

BOOKING\_EXPIRED

which then triggers:

CANCEL\_CALENDAR\_SLOT  
SEND\_BOOKING\_EXPIRATION\_NOTIFICATION

---

# **9\. Side Effect Attempts**

## **`booking_side_effect_attempts`**

Audit log of execution attempts.

id  
booking\_side\_effect\_id  
attempt\_num  
api\_log\_id  
status  
error\_message  
created\_at

### **Attempt Status**

SUCCESS  
FAILED

---

# **10\. Side Effect Execution Rules**

1. **Events create side effects**  
2. Side effects may emit **new events** if execution reveals a new fact  
3. Cron **never creates business events**  
4. Cron only executes **due verification side effects**  
5. Long-running verification flows should reuse **one pending row**  
6. `expires_at` represents the **next meaningful checkpoint**  
7. A `SUCCESS` status must mean the action truly occurred

---

# **11\. Architectural Philosophy**

The system follows a simple chain:

Event  
   ↓  
Side Effects  
   ↓  
Provider call or verification  
   ↓  
Maybe new Event

Example:

BOOKING\_FORM\_SUBMITTED  
    ↓  
CREATE\_STRIPE\_CHECKOUT  
VERIFY\_STRIPE\_PAYMENT  
    ↓  
PAYMENT\_SETTLED  
    ↓  
RESERVE\_CALENDAR\_SLOT  
SEND\_BOOKING\_CONFIRMATION

---

# **12\. Why This Design Works**

This architecture:

* avoids mixing **state and events**  
* avoids **fake events**  
* keeps **verification logic explicit**  
* keeps **provider actions isolated**  
* allows **safe retries**  
* supports **event-driven orchestration**

The result is a system that is:

* debuggable  
* auditable  
* resilient  
* easy to extend

---

If you'd like, I can also give you the **two extremely valuable companion artifacts** that make systems like this easy to maintain:

1. **A visual flow diagram of the booking lifecycle** (much easier for coders to reason about than tables)  
2. **A decision tree for the sweeper** (so the coder doesn't accidentally create duplicate verification rows again)

Both dramatically reduce future complexity.

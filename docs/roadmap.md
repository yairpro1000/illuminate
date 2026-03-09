

---

# **1️⃣ What You Must Set Up Before Vibe Coding**

### **Accounts & Infrastructure**

* Cloudflare account (Pages \+ Workers enabled)  
* Supabase project (DB \+ Auth enabled)  
* Stripe account (business verified)  
* Google Cloud project (Calendar API enabled)  
* Dedicated Google account for calendar (separate from personal)  
* Email sending provider account (e.g., Resend)  
* Domain name \+ DNS control

### **Stripe Preparation**

* Products & prices defined  
* Multi-currency enabled (if needed)  
* TWINT enabled (if applicable)  
* Invoice settings configured (branding \+ numbering)  
* Webhook endpoint placeholder URL  
* Test mode enabled and test cards ready

### **Google Calendar Preparation**

* Dedicated calendar created  
* OAuth credentials created (Web application)  
* Redirect URIs defined  
* Refresh token obtained and stored securely

### **Supabase Preparation**

* Database schema drafted  
* Environment variables prepared  
* Service role key stored securely

### **Security & Environment**

* Environment variable list finalized  
* Separate dev and prod environments decided  
* Turnstile site key \+ secret generated  
* Admin email chosen (for future auth)

### **Legal & Business**

* Business address \+ details finalized  
* Cancellation/reschedule policy written  
* Privacy policy draft prepared  
* Pricing structure finalized (no improvising mid-build)

---

# **2️⃣ Instruction Files for the Vibe Coding Model**

(Names \+ what they contain — titles only)

---

### **`product_spec.md`**

* System Overview  
* User Flows  
* Booking Flow  
* Payment Flow  
* Reschedule Flow  
* Cash Invoice Flow  
* Error Handling Overview

---

### **`architecture.md`**

* High-Level Architecture Diagram  
* Tech Stack Summary  
* Responsibility Separation (Stripe / DB / Calendar)  
* Data Flow Description  
* Environment Strategy  
* Security Model

---

### **`site_database_schema.md`**

* Tables Overview  
* bookings Table  
* payments Table  
* expenses Table  
* Indexes  
* Relationships  
* Migration Plan

---

### **`api_contracts.md`**

* Endpoint List  
* Request Schemas  
* Response Schemas  
* Error Codes  
* Webhook Contracts  
* Idempotency Rules

---

### **`stripe_integration.md`**

* Stripe Objects Used  
* Checkout Configuration  
* Invoice Creation Rules  
* Webhook Events Handled  
* Failure Recovery Logic

---

### **`calendar_integration.md`**

* OAuth Flow  
* Token Storage  
* Slot Calculation Logic  
* Event Creation Logic  
* Reschedule Update Logic

---

### **`security.md`**

* Token Signing Strategy  
* Admin Auth Strategy  
* Rate Limiting Strategy  
* CAPTCHA Verification Flow  
* Secrets Management

---

### **`ui_system.md`**

* Design Tokens  
* Theme Strategy  
* Layout Structure  
* Accessibility Requirements  
* Responsive Rules

---

### **`deployment.md`**

* Cloudflare Setup Steps  
* Supabase Setup Steps  
* Environment Variables List  
* Webhook Configuration  
* Production Checklist

---

### **`definition_of_done.md`**

* Functional Requirements  
* Reliability Requirements  
* Security Requirements  
* UX Requirements  
* Observability Requirements  
* Launch Checklist

(We will fill this later.)

---

Now you have:

* Pre-flight checklist  
* Build instruction map  
* No “oh right I forgot Google OAuth” surprises

When you’re ready, we can start drafting the actual contents of these files in the correct order so vibe coding becomes execution instead of improvisation.

Perfect. This is the consolidated master system document capturing everything we have agreed upon so far.

---

# **📘 MASTER SYSTEM SPECIFICATION**

## **Spiritual Coaching Platform – Phase I (+ Structured Phase II)**

---

# **1\. Vision & Scope**

## **1.1 Business Context**

The platform supports:

* 1:1 spiritual coaching sessions  
* Group sessions and events  
* Online and offline payments  
* Free and paid event bookings  
* Admin-controlled operations

The system must be:

* Low-friction for users  
* Business-protective (calendar safety)  
* Migration-friendly  
* Architecturally clean  
* Portfolio-quality

---

## **1.2 Phase I Goals**

Phase I includes:

* Public website  
* Booking system (1:1 sessions)  
* Event booking system  
* Stripe payments (including TWINT)  
* Invoice generation via Stripe  
* Google Calendar sync  
* Email notifications  
* Anti-bot protection  
* Reminder and follow-up logic  
* Scheduler-agnostic background job design

No full admin UI yet (but data model supports it).

---

## **1.3 Phase II (Structured Placeholders)**

* Admin dashboard  
* Event creation/editing  
* Media upload & reorder  
* Manual payment overrides  
* Broadcast messaging  
* Expense upload  
* WhatsApp reminders

---

# **2\. High-Level Architecture**

* **Frontend**: Cloudflare Pages (static)  
* **API layer**: Cloudflare Workers  
* **Database & Auth**: Supabase (Postgres \+ Auth)  
* **Payments & Invoicing**: Stripe (TWINT enabled)  
* **Calendar**: Google Calendar API  
* **Email**: Provider (e.g., Resend)  
* **Anti-bot**: Turnstile/reCAPTCHA  
* **Scheduling**: Scheduler-agnostic endpoints (triggered by Cloudflare cron or equivalent)

Migration principle:

* Business logic separated from hosting runtime.  
* Scheduler independent from core logic.

---

# **3\. Core Domain Concepts**

* Booking (1:1 session)  
* Event  
* Event Registration  
* Payment  
* Media  
* Reminder  
* Broadcast (future)  
* Status lifecycle state machines

---

# **4\. Booking System Specification (1:1 Sessions)**

---

## **4.1 Booking Status Lifecycle**

`pending_email`  
`pending_payment`  
`confirmed`  
`cash_ok`  
`cancelled`  
`expired`

---

## **4.2 Pay Now Flow**

1. User selects slot.  
2. Booking created with 15-minute hold:  
   * `checkout_hold_expires_at = now + 15m`  
3. Stripe Checkout session created.  
4. If webhook success:  
   * Create Google Calendar event.  
   * Set status \= `confirmed`.  
   * Send confirmation email (includes address \+ Maps link \+ manage link).

If not paid within 15 minutes:

* Release hold.  
* Status → `expired`.

---

## **4.3 Pay Later Flow**

1. Booking created.  
2. Email confirmation required.  
3. If confirmed:  
   * Create calendar event.  
   * Status → `pending_payment`.  
   * `payment_due_at = starts_at - 24h`  
   * Compute reminder time.

Payment must be completed before `payment_due_at`.

If unpaid at due time:

* Cancel booking.  
* Remove calendar event.  
* Status → `cancelled`.  
* Send cancellation email.

---

## **4.4 Payment Due Reminder Logic**

Reminder time \=

Prefer:  
`payment_due_at - 6h`

If this falls between 22:00–08:00 local time:  
Use:  
18:00 on the day before session.

If 18:00 has already passed:  
Use:  
08:00 next reasonable morning.

Store:

* `payment_due_reminder_scheduled_at`  
* `payment_due_reminder_sent_at`

---

## **4.5 Follow-up for Unconfirmed**

If email confirmation not completed:

* Expire after confirmation window.  
* Send one follow-up at \+2h.  
* Store `followup_sent_at`.

---

## **4.6 Manual Override**

Admin may set status to:

* `confirmed` (payment received manually)  
* `cash_ok` (allow payment in person; bypass auto-cancel)

---

# **5\. Event System Specification**

---

## **5.1 Event Model**

Events can be:

* Free  
* Paid  
* Capacity-limited

---

## **5.2 Event Booking Status Lifecycle**

`pending_email`  
`pending_payment`  
`confirmed`  
`cancelled`  
`expired`

---

## **5.3 Booking Rule**

* One booking row represents one attendee.  
* No guest / plus-one system in the current design.  
* Every attendee must register as a real client booking.

---

## **5.4 Free Event Flow**

1. Booking submitted (phone required).  
2. Status → `pending_email`  
3. Confirmation required within 15 minutes.  
4. Follow-up at \+2h if not confirmed.  
5. Reminder 24h before event (if opted in).

---

## **5.5 Paid Event Flow**

1. Booking submitted.  
2. Status → `pending_payment`  
3. Checkout hold applied.  
4. Stripe success:  
   * Status → `confirmed`  
   * Send confirmation email \+ invoice link  
5. If unpaid at \+2h:  
   * Send payment reminder.  
6. If capacity is limited:  
   * Spot only secured after payment success.

---

## **5.6 Late / Walk-In Access**

* Event-specific QR / late-access link  
* Valid only for the target event  
* Can stay active until 2h after event end  
* Capacity still enforced server-side

---

## **5.7 Share Feature**

* Web Share API  
* Copy link fallback

---

# **6\. Admin System (Phase II)**

Includes:

* Event create/edit  
* Media upload (images/videos)  
* Media reordering via `sort_order`  
* Manual booking overrides  
* cash\_ok setting  
* Expense upload placeholder

---

# **7\. Database Schema (Consolidated Overview)**

Tables:

* bookings  
* events  
* payments  
* event\_media  
* event\_reminder\_subscriptions  
* event\_late\_access\_links

Lifecycle fields included:

* checkout\_hold\_expires\_at  
* confirm\_expires\_at  
* payment\_due\_at  
* reminder\_scheduled\_at  
* followup\_scheduled\_at  
* \*\_sent\_at timestamps

---

# **8\. Background Job Design**

Scheduler-agnostic endpoints:

* run\_checkout\_expiry  
* run\_unconfirmed\_followups  
* run\_payment\_due\_reminders  
* run\_payment\_due\_cancellations  
* run\_24h\_event\_reminders

All jobs must be:

* Idempotent  
* Safe to run multiple times

---

# **9\. Security & Anti-Abuse**

* Turnstile required for all public POST endpoints  
* Token hashing for confirm/manage links  
* Stripe webhook signature verification  
* Admin app behind Cloudflare Zero Trust  
* Environment variable isolation  
* No secrets exposed client-side

---

# **10\. Email & Notification Requirements**

Emails must include:

* Session/event details  
* Address  
* Google Maps link  
* Manage/reschedule link  
* Invoice link (if paid)

Follow-ups:

* \+2h reminder for unconfirmed/unpaid  
* 24h reminder before session/event (if opted in)  
* Payment due reminder with human fallback logic

WhatsApp:

* Placeholder for Phase II

---

# **11\. UI & Design System**

* Token-based theming  
* Primary Terracotta theme (Lugano-aligned option available)  
* Neutral background with optional Swiss nature texture  
* Large typography  
* Generous whitespace  
* Mobile-first  
* Accessibility-compliant

Themes must be changeable via CSS variable sets.

---

# **12\. Payment & Invoicing Strategy**

* Stripe is source of truth for payment state.  
* Stripe generates invoice PDFs.  
* Manual Stripe invoice for cash clients.  
* Unified payment table linking bookings/events.  
* Multi-currency supported.  
* Payment status derived from Stripe webhooks.

---

# **13\. Migration & Portability Principles**

* Scheduler independent from hosting  
* Stripe & Calendar treated as external authorities  
* Business logic separated from infrastructure  
* No hard coupling to Cloudflare runtime  
* Replaceable hosting with minimal rewrite

---

# **14\. Definition of Done (Placeholder)**

Will include:

* Functional completeness  
* State transition correctness  
* Reminder reliability  
* Security verification  
* UX acceptance  
* Performance baseline  
* Logging and monitoring  
* Launch checklist

---

This document is now the canonical design reference.

Next move options:

1. Formalize state machines as explicit transition tables.  
2. Generate `site_database_schema.md` in implementation-ready SQL.  
3. Draft `api_contracts.md` with exact endpoint signatures.  
4. Or stress-test edge cases before freezing the spec.

You’re building this like an engineer, not like someone gluing plugins together.

Superseded for runtime/backend implementation by [docs/observability_refactor_policy.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/observability_refactor_policy.md) and [apps/shared/observability/observability_tables_with_app_area.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/apps/shared/observability/observability_tables_with_app_area.sql).

This document remains as older background guidance only. Do not use it as the current observability implementation contract.

Here’s a lightweight, practical **structured logging + correlation ID strategy** for Cloudflare Workers (and it stays portable if you migrate later).

## 1) One correlation ID per request

Rule: every request (public API, webhook, internal job) gets a `request_id`.

**Priority order:**

1. If client sends `X-Request-Id`, use it
2. Else generate a new one (UUID)

Return it back:

* Response header: `X-Request-Id: <id>`

## 2) Standard log shape (JSON)

Log only JSON objects (no free-form strings), so you can filter/search.

Recommended fields:

* `ts` (ISO timestamp)
* `level` (`info|warn|error`)
* `request_id`
* `route`
* `source` (`api|stripe_webhook|job|calendar|email`)
* `operation` (e.g. `booking.pay_now`, `stripe.checkout.session.completed`)
* `entity` object: `{ booking_id, payment_id, event_id, client_id }` as available
* `duration_ms` (for request end log)
* `details` (small safe JSON payload)
* `error` object (safe): `{ code, message, http_status }`

## 3) What gets logged

Per request:

1. **Start log** (info)
2. **End log** (info) with duration and outcome
3. **Error log** (error) if exception or external API fails

For jobs:

* emit structured start/completion/failure events to `observability.logs`
* per failure: write to `observability.logs` + emit `error` log

## 4) Don’t log secrets or raw payloads

Never log:

* tokens (confirm/manage)
* Stripe signing secret
* OAuth refresh tokens
* full webhook payloads
* full email content

If you need payload debugging:

* store a *redacted* subset in `observability.logs.context`

## 5) Minimal Worker helper (drop-in pattern)

(You can paste this into your Worker project.)

```js
// logging.js
export function getRequestId(request) {
  return request.headers.get("X-Request-Id") || crypto.randomUUID();
}

export function log(level, obj) {
  // Always JSON logs
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...obj
  }));
}
```

Usage:

```js
import { getRequestId, log } from "./logging";

export default {
  async fetch(request, env, ctx) {
    const request_id = getRequestId(request);
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const start = Date.now();

    log("info", { request_id, route, source: "api", operation: "request.start" });

    try {
      // ...handle request...
      const duration_ms = Date.now() - start;
      const response = new Response("OK", { status: 200 });
      response.headers.set("X-Request-Id", request_id);

      log("info", { request_id, route, source: "api", operation: "request.end", duration_ms, status: 200 });
      return response;
    } catch (err) {
      const duration_ms = Date.now() - start;

      log("error", {
        request_id,
        route,
        source: "api",
        operation: "request.error",
        duration_ms,
        error: { message: err?.message || "unknown" }
      });

      const response = new Response("Internal Error", { status: 500 });
      response.headers.set("X-Request-Id", request_id);
      return response;
    }
  }
}
```

## 6) Link logs ↔ DB failure logs

When you insert into `observability.logs`, always include:

* `request_id`
* `source`
* `operation`
* relevant entity IDs
* safe `context`

Then your debugging flow is:

* find failing request_id in DB → search logs by request_id → see exact chain.

## 7) Bonus: external-call wrapper (prevents silent failures)

Wrap all Stripe/Google/Email calls with a helper that:

* logs start/end
* records failures to `observability.logs` with `retryable=true/false`

This is the “adult supervision” layer.

Here’s a simple, safe **redaction policy** you can apply to anything you’re about to log or store in `observability.logs.context`.

## Redaction goals

* Never leak credentials, tokens, or PII beyond what you truly need.
* Keep enough context to debug (IDs, timestamps, endpoint names, Stripe event IDs).
* Default to “deny,” then allow a small whitelist.

---

## 1) Keys to always remove (case-insensitive match)

Strip any field whose key contains (substring match):

* `password`
* `pass`
* `secret`
* `token`
* `apikey` / `api_key`
* `authorization`
* `cookie`
* `session`
* `refresh`
* `private`
* `signature` (Stripe signatures!)
* `client_secret`
* `access_key`
* `webhook_secret`
* `key`

Also remove these exact headers if present:

* `Authorization`
* `Cookie`
* `Set-Cookie`
* `Stripe-Signature`

---

## 2) PII minimization rules

For public-user fields, store only what you need:

### Emails

* Prefer storing a **hash** or a partially masked version in logs:

  * `alice@example.com` → `a***@example.com`
* In DB tables (bookings/clients), you store full email—that’s business data.
* In logs/failure context, mask it.

### Phone numbers

* Mask all but last 2–4 digits:

  * `+41791234567` → `+41******4567`

### Names / free text

* Avoid storing full message bodies in logs (`contact form message`, `email body`).
* If needed, store the first ~80 chars and truncate.

---

## 3) Whitelist (safe fields to keep)

These are generally safe and useful:

* `request_id`
* `route`, `method`
* `operation`
* `booking_id`, `event_id`, `client_id`, `payment_id`
* `stripe_event_id`, `stripe_checkout_session_id`, `stripe_payment_intent_id` (IDs are ok)
* `google_event_id`
* `http_status`
* `attempts`
* timestamps: `starts_at`, `ends_at`, `expires_at`, `created_at`
* `currency`, `amount`
* `timezone`

---

## 4) Practical redaction function (JS)

A straightforward deep-redactor for Workers:

```js
const SENSITIVE_KEYWORDS = [
  "password","pass","secret","token","apikey","api_key","authorization","cookie",
  "session","refresh","private","signature","client_secret","access_key","key","webhook_secret"
];

const SENSITIVE_HEADERS = new Set([
  "authorization","cookie","set-cookie","stripe-signature"
]);

function looksSensitiveKey(key) {
  const k = String(key).toLowerCase();
  return SENSITIVE_KEYWORDS.some(word => k.includes(word));
}

function maskEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) return email;
  const [user, domain] = email.split("@");
  const maskedUser = user.length <= 1 ? "*" : user[0] + "***";
  return `${maskedUser}@${domain}`;
}

function maskPhone(phone) {
  if (typeof phone !== "string") return phone;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "***";
  return phone.slice(0, 3) + "******" + phone.slice(-4);
}

function redactValue(key, value) {
  const k = String(key).toLowerCase();
  if (k.includes("email")) return maskEmail(value);
  if (k.includes("phone")) return maskPhone(value);
  if (typeof value === "string" && value.length > 300) return value.slice(0, 300) + "…(truncated)";
  return value;
}

export function redact(obj) {
  if (obj == null) return obj;

  if (Array.isArray(obj)) return obj.map(redact);

  if (typeof obj === "object") {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (looksSensitiveKey(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      // Special-case headers bag
      if (key.toLowerCase() === "headers" && typeof value === "object" && value) {
        const headersOut = {};
        for (const [hk, hv] of Object.entries(value)) {
          if (SENSITIVE_HEADERS.has(hk.toLowerCase())) headersOut[hk] = "[REDACTED]";
          else headersOut[hk] = redactValue(hk, hv);
        }
        out[key] = headersOut;
        continue;
      }

      out[key] = redactValue(key, redact(value));
    }
    return out;
  }

  return obj;
}
```

Usage:

* Before `console.log(JSON.stringify(...))`
* Before inserting `observability.logs.context`

---

## 5) Default policy

* If you’re unsure whether something is safe, **redact it**.
* Keep IDs, timestamps, and statuses. That’s usually enough to debug 90% of issues.

If you want, I can also propose a tiny `log_event()` helper that automatically applies `redact()` + attaches `request_id` + `source` + `operation` consistently.

Excellent. Let’s make logging impossible to mess up.

Here’s a small **`log_event()` helper layer** that:

* Automatically attaches `request_id`
* Applies `redact()`
* Emits structured JSON
* Optionally writes to `observability.logs`
* Keeps your code clean

This is production-grade but still lightweight.

---

# logging.js

```js
import { redact } from "./redact"; // the function we defined earlier

export function getRequestId(request) {
  return request.headers.get("X-Request-Id") || crypto.randomUUID();
}

export function log_event({
  level = "info",
  request_id,
  source,
  operation,
  route = null,
  entity = {},
  details = {},
  error = null,
  duration_ms = null
}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    request_id,
    source,            // api | stripe_webhook | job | calendar | email
    operation,         // booking.pay_now | stripe.webhook | job.send_reminders
    route,
    entity,            // { booking_id, event_id, client_id, payment_id }
    duration_ms,
    details,
    error
  };

  console.log(JSON.stringify(redact(payload)));
}
```

---

# Optional: log_failure_to_db()

This writes to `observability.logs` safely and consistently.

```js
export async function log_failure_to_db({
  db,
  request_id,
  source,
  operation,
  severity = "error",
  entity = {},
  error,
  retryable = true,
  context = {}
}) {
  await db.from("observability.logs").insert({
    source,
    operation,
    severity,
    status: "open",
    request_id,
    booking_id: entity.booking_id || null,
    payment_id: entity.payment_id || null,
    client_id: entity.client_id || null,
    error_message: error?.message || "Unknown error",
    error_code: error?.code || null,
    http_status: error?.status || null,
    retryable,
    context: redact(context)
  });
}
```

---

# Example Usage in API Route

```js
const request_id = getRequestId(request);
const route = "POST /api/bookings/pay-now";
const start = Date.now();

log_event({
  level: "info",
  request_id,
  source: "api",
  operation: "booking.pay_now.start",
  route
});

try {
  // booking logic...

  log_event({
    level: "info",
    request_id,
    source: "api",
    operation: "booking.pay_now.success",
    route,
    entity: { booking_id },
    duration_ms: Date.now() - start
  });

} catch (err) {

  await log_failure_to_db({
    db,
    request_id,
    source: "api",
    operation: "booking.pay_now",
    entity: { booking_id },
    error: err,
    context: { input_payload }
  });

  log_event({
    level: "error",
    request_id,
    source: "api",
    operation: "booking.pay_now.error",
    route,
    error: { message: err.message }
  });

  throw err;
}
```

---

# What This Gives You

Now every flow has:

* One `request_id`
* Clean JSON logs
* DB failure entries
* No secret leakage
* Idempotent-friendly tracing
* Debuggable job runs

This is the difference between:

> “Stripe didn’t work once, I think…”

and

> “Webhook received, signature valid, DB update failed at step 3, retry scheduled.”

That’s adult infrastructure.

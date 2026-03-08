import type { Env } from './env.js';
import type { Providers } from './providers/index.js';
import type { Logger } from './lib/logger.js';

import { handleGetSlots }      from './handlers/slots.js';
import { handleHealth }        from './handlers/health.js';
import { handlePayNow, handlePayLater } from './handlers/bookings.js';
import { handleConfirm }       from './handlers/confirm.js';
import { handleManageInfo }    from './handlers/manage-info.js';
import { handleManageCancel }  from './handlers/manage-cancel.js';
import { handleManageReschedule } from './handlers/manage-reschedule.js';
import { handleGetEvents, handleGetEvent } from './handlers/events.js';
import { handleEventRegister } from './handlers/registrations.js';
import { handleStripeWebhook } from './handlers/webhook.js';
import { handleJobTrigger }    from './handlers/jobs.js';
import {
  handleSimulatePayment,
  handleDevEmails,
  handleDevFailures,
  handleDevBookings,
} from './handlers/dev.js';

import { handlePreflight, getAllowedOrigin, addCors } from './lib/cors.js';
import { jsonResponse } from './lib/errors.js';

export interface AppContext {
  providers: Providers;
  env:       Env;
  logger:    Logger;
  requestId: string;
}

type Handler = (
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
) => Promise<Response>;

interface Route {
  method:  string;        // 'GET' | 'POST' | '*'
  pattern: RegExp;
  keys:    string[];      // named capture group names in order
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const src = path.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { method, pattern: new RegExp('^' + src + '$'), keys, handler };
}

const ROUTES: Route[] = [
  route('GET',  '/api/health',                   handleHealth),
  route('GET',  '/api/slots',                    handleGetSlots),
  route('POST', '/api/bookings/pay-now',         handlePayNow),
  route('POST', '/api/bookings/pay-later',       handlePayLater),
  route('GET',  '/api/confirm',                  handleConfirm),
  route('GET',  '/api/manage',                   handleManageInfo),
  route('POST', '/api/manage/cancel',            handleManageCancel),
  route('POST', '/api/manage/reschedule',        handleManageReschedule),
  route('GET',  '/api/events',                   handleGetEvents),
  route('GET',  '/api/events/:slug',             handleGetEvent),
  route('POST', '/api/events/:slug/register',    handleEventRegister),
  route('POST', '/api/stripe/webhook',           handleStripeWebhook),
  route('POST', '/api/jobs/:name',               handleJobTrigger),
  // Dev-only
  route('POST', '/api/__dev/simulate-payment',   handleSimulatePayment),
  route('GET',  '/api/__dev/emails',             handleDevEmails),
  route('GET',  '/api/__dev/failures',           handleDevFailures),
  route('GET',  '/api/__dev/bookings',           handleDevBookings),
];

export async function handleRequest(request: Request, ctx: AppContext): Promise<Response> {
  const url    = new URL(request.url);
  const origin = getAllowedOrigin(request, ctx.env.SITE_URL);

  if (request.method === 'OPTIONS') {
    return origin
      ? handlePreflight(origin)
      : new Response(null, { status: 403 });
  }

  // Only serve /api/* paths
  if (!url.pathname.startsWith('/api/')) {
    return jsonResponse({ error: 'NOT_FOUND', message: 'Not found' }, 404);
  }

  console.log(`[router] ${request.method} ${url.pathname}`);

  for (const r of ROUTES) {
    const match = r.pattern.exec(url.pathname);
    if (!match) continue;
    if (r.method !== '*' && r.method !== request.method) {
      const res = jsonResponse({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }, 405);
      return origin ? addCors(res, origin) : res;
    }

    console.log(`[router] matched → ${r.method} ${r.pattern}`);
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = match[i + 1] ?? ''; });

    const res = await r.handler(request, ctx, params);
    console.log(`[router] response status ${res.status}`);
    return origin ? addCors(res, origin) : res;
  }

  console.log(`[router] no route matched for ${url.pathname}`);
  const res = jsonResponse({ error: 'NOT_FOUND', message: 'Not found' }, 404);
  return origin ? addCors(res, origin) : res;
}

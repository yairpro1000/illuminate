import type {
  CheckoutSession,
  CreateCheckoutParams,
  CreateInvoiceParams,
  InvoiceRecord,
  IPaymentsProvider,
  StripePaymentEvent,
} from './interface.js';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

type StripeObject = Record<string, unknown>;

export class StripePaymentsProvider implements IPaymentsProvider {
  constructor(
    private readonly secretKey: string,
    private readonly siteUrl: string,
  ) {}

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession> {
    const customerId = await this.ensureCustomer({
      email: params.customerEmail,
      name: params.customerName ?? null,
      existingStripeCustomerId: params.existingStripeCustomerId ?? null,
      metadata: params.metadata ?? {},
    });

    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('success_url', params.successUrl);
    form.set('cancel_url', params.cancelUrl);
    form.set('client_reference_id', params.bookingId);
    form.set('customer', customerId);
    form.set('metadata[booking_id]', params.bookingId);
    form.set('metadata[payment_flow]', 'pay_now');
    form.set('metadata[site_url]', this.siteUrl);
    form.set('payment_intent_data[metadata][booking_id]', params.bookingId);
    form.set('payment_intent_data[metadata][payment_flow]', 'pay_now');
    form.set('payment_intent_data[metadata][site_url]', this.siteUrl);
    appendMetadata(form, params.metadata);
    appendMetadata(form, params.metadata, 'payment_intent_data[metadata]');
    params.lineItems.forEach((item, index) => {
      form.set(`line_items[${index}][quantity]`, String(item.quantity));
      form.set(`line_items[${index}][price_data][currency]`, normalizeCurrencyForStripe(item.currency));
      form.set(`line_items[${index}][price_data][unit_amount]`, String(toMinorAmount(item.amount, item.currency)));
      form.set(`line_items[${index}][price_data][product_data][name]`, item.name);
      if (item.description) {
        form.set(`line_items[${index}][price_data][product_data][description]`, item.description);
      }
    });

    const session = await this.postForm<StripeObject>('/checkout/sessions', form, params.idempotencyKey);
    return {
      sessionId: asString(session['id']),
      checkoutUrl: asString(session['url']),
      amount: fromMinorAmount(asNumber(session['amount_total']), asString(session['currency'], 'CHF')),
      currency: normalizeCurrency(asString(session['currency'], 'CHF')),
      customerId,
      paymentIntentId: asNullableString(session['payment_intent']),
      rawPayload: session,
    };
  }

  async createInvoice(params: CreateInvoiceParams): Promise<InvoiceRecord> {
    const customerId = await this.ensureCustomer({
      email: params.customerEmail,
      name: params.customerName ?? null,
      existingStripeCustomerId: params.existingStripeCustomerId ?? null,
      metadata: params.metadata ?? {},
    });

    const invoiceForm = new URLSearchParams();
    invoiceForm.set('customer', customerId);
    invoiceForm.set('collection_method', 'send_invoice');
    invoiceForm.set('auto_advance', 'false');
    invoiceForm.set('metadata[booking_id]', params.bookingId);
    invoiceForm.set('metadata[payment_flow]', 'pay_later');
    invoiceForm.set('metadata[site_url]', this.siteUrl);
    if (params.dueDateIso) {
      invoiceForm.set('due_date', String(Math.floor(new Date(params.dueDateIso).getTime() / 1000)));
    } else {
      invoiceForm.set('days_until_due', '1');
    }
    appendMetadata(invoiceForm, params.metadata);

    const invoice = await this.postForm<StripeObject>(
      '/invoices',
      invoiceForm,
      params.idempotencyKey ? `${params.idempotencyKey}:invoice` : undefined,
    );
    const invoiceId = asString(invoice['id']);

    const invoiceItemForm = new URLSearchParams();
    invoiceItemForm.set('customer', customerId);
    invoiceItemForm.set('invoice', invoiceId);
    invoiceItemForm.set('currency', normalizeCurrencyForStripe(params.currency));
    invoiceItemForm.set('amount', String(toMinorAmount(params.amount, params.currency)));
    invoiceItemForm.set('description', params.description?.trim() || params.title);
    invoiceItemForm.set('metadata[booking_id]', params.bookingId);
    appendMetadata(invoiceItemForm, params.metadata);

    await this.postForm<StripeObject>(
      '/invoiceitems',
      invoiceItemForm,
      params.idempotencyKey ? `${params.idempotencyKey}:invoice-item` : undefined,
    );

    const finalizedInvoice = await this.postForm<StripeObject>(
      `/invoices/${encodeURIComponent(invoiceId)}/finalize`,
      new URLSearchParams(),
      params.idempotencyKey ? `${params.idempotencyKey}:finalize` : undefined,
    );

    return {
      invoiceId,
      invoiceUrl: asString(finalizedInvoice['hosted_invoice_url']),
      amount: fromMinorAmount(
        asNumber(finalizedInvoice['amount_due'] ?? finalizedInvoice['amount_remaining'] ?? 0),
        asString(finalizedInvoice['currency'], params.currency),
      ),
      currency: normalizeCurrency(asString(finalizedInvoice['currency'], params.currency)),
      customerId,
      paymentIntentId: asNullableString(finalizedInvoice['payment_intent']),
      paymentLinkId: asNullableString(finalizedInvoice['payment_link']),
      rawPayload: finalizedInvoice,
    };
  }

  async parseWebhookEvent(
    rawBody: string,
    signature: string,
    secret: string,
  ): Promise<StripePaymentEvent | null> {
    await verifyStripeSignature(rawBody, signature, secret);

    const parsed = JSON.parse(rawBody) as StripeObject;
    const eventType = asString(parsed['type'], '');
    const eventData = parsed['data'];
    const eventObject = isRecord(eventData) && isRecord(eventData['object'])
      ? eventData['object'] as StripeObject
      : null;
    if (!eventObject) return null;

    const metadata = isRecord(eventObject['metadata']) ? eventObject['metadata'] as Record<string, unknown> : {};
    const bookingId = asNullableString(metadata['booking_id']) ?? asNullableString(eventObject['client_reference_id']);

    if (eventType === 'checkout.session.completed') {
      return {
        eventType,
        checkoutSessionId: asNullableString(eventObject['id']),
        paymentIntentId: asNullableString(eventObject['payment_intent']),
        invoiceId: asNullableString(eventObject['invoice']),
        invoiceUrl: null,
        paymentLinkId: asNullableString(eventObject['payment_link']),
        amount: fromMinorAmount(asNumber(eventObject['amount_total'] ?? 0), asString(eventObject['currency'], 'CHF')),
        currency: normalizeCurrency(asString(eventObject['currency'], 'CHF')),
        bookingId,
        customerId: asNullableString(eventObject['customer']),
        rawPayload: parsed,
      };
    }

    if (eventType === 'invoice.paid') {
      return {
        eventType,
        checkoutSessionId: null,
        paymentIntentId: asNullableString(eventObject['payment_intent']),
        invoiceId: asNullableString(eventObject['id']),
        invoiceUrl: asNullableString(eventObject['hosted_invoice_url']),
        paymentLinkId: asNullableString(eventObject['payment_link']),
        amount: fromMinorAmount(
          asNumber(eventObject['amount_paid'] ?? eventObject['amount_due'] ?? 0),
          asString(eventObject['currency'], 'CHF'),
        ),
        currency: normalizeCurrency(asString(eventObject['currency'], 'CHF')),
        bookingId,
        customerId: asNullableString(eventObject['customer']),
        rawPayload: parsed,
      };
    }

    if (eventType === 'payment_intent.succeeded') {
      return {
        eventType,
        checkoutSessionId: null,
        paymentIntentId: asNullableString(eventObject['id']),
        invoiceId: asNullableString(eventObject['invoice']),
        invoiceUrl: null,
        paymentLinkId: null,
        amount: fromMinorAmount(
          asNumber(eventObject['amount_received'] ?? eventObject['amount'] ?? 0),
          asString(eventObject['currency'], 'CHF'),
        ),
        currency: normalizeCurrency(asString(eventObject['currency'], 'CHF')),
        bookingId,
        customerId: asNullableString(eventObject['customer']),
        rawPayload: parsed,
      };
    }

    return null;
  }

  private async ensureCustomer(input: {
    email: string;
    name: string | null;
    existingStripeCustomerId: string | null;
    metadata: Record<string, string>;
  }): Promise<string> {
    if (input.existingStripeCustomerId) return input.existingStripeCustomerId;

    const query = new URLSearchParams({
      email: input.email,
      limit: '1',
    });
    const listed = await this.getJson<StripeObject>(`/customers?${query.toString()}`);
    const firstCustomer = Array.isArray(listed['data']) ? listed['data'][0] as StripeObject | undefined : undefined;
    if (firstCustomer?.['id']) {
      return asString(firstCustomer['id']);
    }

    const form = new URLSearchParams();
    form.set('email', input.email);
    if (input.name) form.set('name', input.name);
    appendMetadata(form, input.metadata);
    const created = await this.postForm<StripeObject>('/customers', form);
    return asString(created['id']);
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: 'GET',
      headers: this.requestHeaders(),
    });
    return parseStripeResponse<T>(response);
  }

  private async postForm<T>(path: string, form: URLSearchParams, idempotencyKey?: string): Promise<T> {
    const response = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers: this.requestHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      }),
      body: form.toString(),
    });
    return parseStripeResponse<T>(response);
  }

  private requestHeaders(extra: Record<string, string> = {}): HeadersInit {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      ...extra,
    };
  }
}

async function parseStripeResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) as StripeObject : {};
  if (!response.ok) {
    const error = isRecord(body['error']) ? body['error'] as StripeObject : null;
    throw new Error(
      error?.['message']
        ? `stripe_request_failed:${String(error['message'])}`
        : `stripe_request_failed:${response.status}`,
    );
  }
  return body as T;
}

function appendMetadata(
  form: URLSearchParams,
  metadata: Record<string, string> | undefined,
  prefix = 'metadata',
): void {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    if (!value) continue;
    form.set(`${prefix}[${key}]`, value);
  }
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function normalizeCurrencyForStripe(currency: string): string {
  return normalizeCurrency(currency).toLowerCase();
}

function toMinorAmount(amount: number, currency: string): number {
  const normalizedCurrency = normalizeCurrency(currency);
  if (ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}

function fromMinorAmount(amount: number, currency: string): number {
  const normalizedCurrency = normalizeCurrency(currency);
  if (ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return amount;
  }
  return Math.round((amount / 100) * 100) / 100;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function verifyStripeSignature(rawBody: string, signature: string, secret: string): Promise<void> {
  if (!secret) throw new Error('stripe_webhook_secret_missing');

  const parsedHeader = parseStripeSignature(signature);
  if (!parsedHeader.timestamp || parsedHeader.signatures.length === 0) {
    throw new Error('stripe_webhook_signature_missing_components');
  }

  const signedPayload = `${parsedHeader.timestamp}.${rawBody}`;
  const expectedSignature = await computeHmacSha256(secret, signedPayload);
  const isValid = parsedHeader.signatures.some((candidate) => secureCompare(candidate, expectedSignature));
  if (!isValid) {
    throw new Error('stripe_webhook_signature_invalid');
  }
}

function parseStripeSignature(header: string): { timestamp: string | null; signatures: string[] } {
  const parts = header.split(',').map((part) => part.trim()).filter(Boolean);
  const signatures: string[] = [];
  let timestamp: string | null = null;

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (!key || !value) continue;
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }

  return { timestamp, signatures };
}

async function computeHmacSha256(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function secureCompare(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

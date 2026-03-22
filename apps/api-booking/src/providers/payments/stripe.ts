import type {
  CheckoutSession,
  CreateCheckoutParams,
  CreateInvoiceParams,
  CreateRefundParams,
  InvoiceDetails,
  InvoiceRecord,
  IPaymentsProvider,
  PaymentArtifactDetails,
  RefundRecord,
  StripeWebhookEvent,
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
    const siteUrl = params.siteUrl ?? this.siteUrl;
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
    form.set('metadata[site_url]', siteUrl);
    form.set('invoice_creation[enabled]', 'true');
    form.set('invoice_creation[invoice_data][metadata][booking_id]', params.bookingId);
    form.set('invoice_creation[invoice_data][metadata][payment_flow]', 'pay_now');
    form.set('invoice_creation[invoice_data][metadata][site_url]', siteUrl);
    form.set('payment_intent_data[metadata][booking_id]', params.bookingId);
    form.set('payment_intent_data[metadata][payment_flow]', 'pay_now');
    form.set('payment_intent_data[metadata][site_url]', siteUrl);
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
    const siteUrl = params.siteUrl ?? this.siteUrl;
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
    invoiceForm.set('metadata[site_url]', siteUrl);
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

  async getInvoiceDetails(invoiceId: string): Promise<InvoiceDetails> {
    const invoice = await this.getJson<StripeObject>(`/invoices/${encodeURIComponent(invoiceId)}`);
    return {
      invoiceId: asString(invoice['id']),
      invoiceUrl: asNullableString(invoice['hosted_invoice_url']),
      paymentIntentId: expandId(invoice['payment_intent']),
      paymentLinkId: expandId(invoice['payment_link']),
      amount: fromMinorAmount(
        asNumber(invoice['amount_paid'] ?? invoice['amount_due'] ?? invoice['amount_remaining'] ?? 0),
        asString(invoice['currency'], 'CHF'),
      ),
      currency: normalizeCurrency(asString(invoice['currency'], 'CHF')),
      rawPayload: invoice,
    };
  }

  async getPaymentArtifactDetails(input: {
    paymentIntentId?: string | null;
    invoiceId?: string | null;
    chargeId?: string | null;
  }): Promise<PaymentArtifactDetails> {
    let invoiceId = input.invoiceId ?? null;
    let invoiceUrl: string | null = null;
    let paymentIntentId = input.paymentIntentId ?? null;
    let paymentLinkId: string | null = null;
    let chargeId = input.chargeId ?? null;
    let receiptUrl: string | null = null;
    let invoicePayload: StripeObject | null = null;
    let paymentIntentPayload: StripeObject | null = null;
    let chargePayload: StripeObject | null = null;

    if (invoiceId) {
      invoicePayload = await this.getJson<StripeObject>(
        `/invoices/${encodeURIComponent(invoiceId)}?expand[]=charge&expand[]=payment_intent&expand[]=payment_intent.latest_charge`,
      );
      invoiceId = asNullableString(invoicePayload['id']) ?? invoiceId;
      invoiceUrl = asNullableString(invoicePayload['hosted_invoice_url']);
      paymentIntentId = expandId(invoicePayload['payment_intent']) ?? paymentIntentId;
      paymentLinkId = expandId(invoicePayload['payment_link']);
      chargeId = expandId(invoicePayload['charge']) ?? chargeId;
      receiptUrl = extractChargeReceiptUrl(invoicePayload['charge'])
        ?? extractPaymentIntentReceiptUrl(invoicePayload['payment_intent'])
        ?? receiptUrl;
    }

    if (!receiptUrl && chargeId) {
      chargePayload = await this.getJson<StripeObject>(`/charges/${encodeURIComponent(chargeId)}`);
      chargeId = asNullableString(chargePayload['id']) ?? chargeId;
      receiptUrl = asNullableString(chargePayload['receipt_url']);
    }

    if (!receiptUrl && paymentIntentId) {
      paymentIntentPayload = await this.getJson<StripeObject>(
        `/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`,
      );
      paymentIntentId = asNullableString(paymentIntentPayload['id']) ?? paymentIntentId;
      chargeId = expandId(paymentIntentPayload['latest_charge']) ?? chargeId;
      receiptUrl = extractPaymentIntentReceiptUrl(paymentIntentPayload) ?? receiptUrl;
    }

    return {
      invoiceId,
      invoiceUrl,
      paymentIntentId,
      paymentLinkId,
      chargeId,
      receiptUrl,
      rawPayload: {
        invoice: invoicePayload,
        payment_intent: paymentIntentPayload,
        charge: chargePayload,
      },
    };
  }

  async createRefund(params: CreateRefundParams): Promise<RefundRecord> {
    if (params.stripeInvoiceId) {
      const creditNoteForm = new URLSearchParams();
      creditNoteForm.set('invoice', params.stripeInvoiceId);
      creditNoteForm.set('amount', String(toMinorAmount(params.amount, params.currency)));
      creditNoteForm.set('refund_amount', String(toMinorAmount(params.amount, params.currency)));
      creditNoteForm.set('memo', params.reasonText);
      creditNoteForm.set('reason', 'order_change');
      creditNoteForm.set('email_type', 'none');
      creditNoteForm.set('metadata[booking_id]', params.bookingId);
      creditNoteForm.set('metadata[payment_id]', params.paymentId);
      creditNoteForm.set('metadata[invoice_id]', params.stripeInvoiceId);
      appendMetadata(creditNoteForm, params.metadata);

      const creditNote = await this.postForm<StripeObject>(
        '/credit_notes',
        creditNoteForm,
        params.idempotencyKey ? `${params.idempotencyKey}:credit-note` : undefined,
      );
      const creditNoteId = asNullableString(creditNote['id']);
      const creditNoteNumber = asNullableString(creditNote['number']) ?? creditNoteId;
      const creditNoteDocumentUrl = asNullableString(creditNote['pdf']);
      const nestedRefundId = extractCreditNoteRefundId(creditNote);
      const fetchedRefund = nestedRefundId
        ? await this.getJson<StripeObject>(`/refunds/${encodeURIComponent(nestedRefundId)}`)
        : null;
      const paymentArtifacts = await this.getPaymentArtifactDetails({
        paymentIntentId: expandId(fetchedRefund?.['payment_intent']) ?? params.stripePaymentIntentId ?? null,
        chargeId: expandId(fetchedRefund?.['charge']) ?? null,
      });

      return {
        refundPath: 'credit_note',
        refundStatus: mapStripeRefundStatus(asNullableString(fetchedRefund?.['status']) ?? null) ?? 'PENDING',
        refundId: nestedRefundId,
        creditNoteId,
        creditNoteNumber,
        creditNoteDocumentUrl,
        receiptUrl: paymentArtifacts.receiptUrl,
        invoiceId: params.stripeInvoiceId,
        paymentIntentId: expandId(fetchedRefund?.['payment_intent']) ?? params.stripePaymentIntentId ?? null,
        amount: fromMinorAmount(
          asNumber(fetchedRefund?.['amount'] ?? creditNote['amount'] ?? 0),
          asString(fetchedRefund?.['currency'] ?? creditNote['currency'], params.currency),
        ),
        currency: normalizeCurrency(asString(fetchedRefund?.['currency'] ?? creditNote['currency'], params.currency)),
        rawPayload: {
          credit_note: creditNote,
          refund: fetchedRefund,
        },
      };
    }

    if (!params.stripePaymentIntentId) {
      throw new Error('stripe_refund_payment_intent_missing');
    }

    const refundForm = new URLSearchParams();
    refundForm.set('payment_intent', params.stripePaymentIntentId);
    refundForm.set('amount', String(toMinorAmount(params.amount, params.currency)));
    refundForm.set('reason', 'requested_by_customer');
    refundForm.set('metadata[booking_id]', params.bookingId);
    refundForm.set('metadata[payment_id]', params.paymentId);
    appendMetadata(refundForm, params.metadata);

    const refund = await this.postForm<StripeObject>(
      '/refunds',
      refundForm,
      params.idempotencyKey ? `${params.idempotencyKey}:refund` : undefined,
    );
    const paymentArtifacts = await this.getPaymentArtifactDetails({
      paymentIntentId: expandId(refund['payment_intent']) ?? params.stripePaymentIntentId,
      chargeId: expandId(refund['charge']) ?? null,
    });

    return {
      refundPath: 'direct_refund',
      refundStatus: mapStripeRefundStatus(asNullableString(refund['status']) ?? null) ?? 'PENDING',
      refundId: asNullableString(refund['id']),
      creditNoteId: null,
      creditNoteNumber: null,
      creditNoteDocumentUrl: null,
      receiptUrl: paymentArtifacts.receiptUrl,
      invoiceId: params.stripeInvoiceId ?? expandId(refund['invoice']),
      paymentIntentId: expandId(refund['payment_intent']) ?? params.stripePaymentIntentId,
      amount: fromMinorAmount(asNumber(refund['amount'] ?? 0), asString(refund['currency'], params.currency)),
      currency: normalizeCurrency(asString(refund['currency'], params.currency)),
      rawPayload: refund,
    };
  }

  async parseWebhookEvent(
    rawBody: string,
    signature: string,
    secret: string,
  ): Promise<StripeWebhookEvent | null> {
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
    const siteUrl = asNullableString(metadata['site_url']);

    if (eventType === 'checkout.session.completed') {
      return {
        eventCategory: 'payment',
        eventType,
        checkoutSessionId: asNullableString(eventObject['id']),
        paymentIntentId: expandId(eventObject['payment_intent']),
        invoiceId: expandId(eventObject['invoice']),
        invoiceUrl: null,
        paymentLinkId: expandId(eventObject['payment_link']),
        receiptUrl: extractPaymentIntentReceiptUrl(eventObject['payment_intent']),
        amount: fromMinorAmount(asNumber(eventObject['amount_total'] ?? 0), asString(eventObject['currency'], 'CHF')),
        currency: normalizeCurrency(asString(eventObject['currency'], 'CHF')),
        bookingId,
        customerId: asNullableString(eventObject['customer']),
        siteUrl,
        rawPayload: parsed,
      };
    }

    if (eventType === 'invoice.paid') {
      return {
        eventCategory: 'payment',
        eventType,
        checkoutSessionId: null,
        paymentIntentId: expandId(eventObject['payment_intent']),
        invoiceId: asNullableString(eventObject['id']),
        invoiceUrl: asNullableString(eventObject['hosted_invoice_url']),
        paymentLinkId: expandId(eventObject['payment_link']),
        receiptUrl: extractChargeReceiptUrl(eventObject['charge'])
          ?? extractPaymentIntentReceiptUrl(eventObject['payment_intent']),
        amount: fromMinorAmount(
          asNumber(eventObject['amount_paid'] ?? eventObject['amount_due'] ?? 0),
          asString(eventObject['currency'], 'CHF'),
        ),
        currency: normalizeCurrency(asString(eventObject['currency'], 'CHF')),
        bookingId,
        customerId: asNullableString(eventObject['customer']),
        siteUrl,
        rawPayload: parsed,
      };
    }

    if (eventType === 'payment_intent.succeeded') {
      return {
        eventCategory: 'payment',
        eventType,
        checkoutSessionId: null,
        paymentIntentId: asNullableString(eventObject['id']),
        invoiceId: expandId(eventObject['invoice']),
        invoiceUrl: null,
        paymentLinkId: null,
        receiptUrl: extractPaymentIntentReceiptUrl(eventObject),
        amount: fromMinorAmount(
          asNumber(eventObject['amount_received'] ?? eventObject['amount'] ?? 0),
          asString(eventObject['currency'], 'CHF'),
        ),
        currency: normalizeCurrency(asString(eventObject['currency'], 'CHF')),
        bookingId,
        customerId: asNullableString(eventObject['customer']),
        siteUrl,
        rawPayload: parsed,
      };
    }

    if (eventType === 'refund.created' || eventType === 'refund.updated' || eventType === 'refund.failed') {
      return {
        eventCategory: 'refund',
        eventType,
        refundId: asNullableString(eventObject['id']),
        creditNoteId: null,
        creditNoteNumber: null,
        creditNoteDocumentUrl: null,
        receiptUrl: extractChargeReceiptUrl(eventObject['charge']),
        paymentIntentId: expandId(eventObject['payment_intent']),
        invoiceId: asNullableString(metadata['invoice_id']),
        refundStatus: mapStripeRefundStatus(asNullableString(eventObject['status'])),
        amount: fromMinorAmount(asNumber(eventObject['amount'] ?? 0), asString(eventObject['currency'], 'CHF')),
        currency: normalizeCurrency(asString(eventObject['currency'], 'CHF')),
        bookingId,
        rawPayload: parsed,
      };
    }

    if (eventType === 'credit_note.created' || eventType === 'credit_note.updated' || eventType === 'credit_note.voided') {
      return {
        eventCategory: 'refund',
        eventType,
        refundId: extractCreditNoteRefundId(eventObject),
        creditNoteId: asNullableString(eventObject['id']),
        creditNoteNumber: asNullableString(eventObject['number']) ?? asNullableString(eventObject['id']),
        creditNoteDocumentUrl: asNullableString(eventObject['pdf']),
        receiptUrl: null,
        paymentIntentId: asNullableString(metadata['payment_intent_id']),
        invoiceId: asNullableString(eventObject['invoice']) ?? asNullableString(metadata['invoice_id']),
        refundStatus: eventType === 'credit_note.voided' ? 'CANCELED' : null,
        amount: fromMinorAmount(
          asNumber(eventObject['amount'] ?? eventObject['subtotal_excluding_tax'] ?? 0),
          asString(eventObject['currency'], 'CHF'),
        ),
        currency: normalizeCurrency(asString(eventObject['currency'], 'CHF')),
        bookingId,
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

function mapStripeRefundStatus(status: string | null): 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | null {
  if (status === 'pending' || status === 'requires_action') return 'PENDING';
  if (status === 'succeeded') return 'SUCCEEDED';
  if (status === 'failed') return 'FAILED';
  if (status === 'canceled') return 'CANCELED';
  return null;
}

function extractCreditNoteRefundId(creditNote: StripeObject): string | null {
  const refunds = creditNote['refunds'];
  if (!Array.isArray(refunds) || refunds.length === 0) return asNullableString(creditNote['refund']);
  const firstRefund = refunds[0];
  if (!isRecord(firstRefund)) return asNullableString(creditNote['refund']);
  return asNullableString(firstRefund['refund']) ?? asNullableString(firstRefund['id']) ?? asNullableString(creditNote['refund']);
}

function expandId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (!isRecord(value)) return null;
  return asNullableString(value['id']);
}

function extractChargeReceiptUrl(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return asNullableString(value['receipt_url']);
}

function extractPaymentIntentReceiptUrl(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return extractChargeReceiptUrl(value['latest_charge']);
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

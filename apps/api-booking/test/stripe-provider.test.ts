import { describe, expect, it, vi } from 'vitest';
import { StripePaymentsProvider } from '../src/providers/payments/stripe.js';

describe('StripePaymentsProvider.parseWebhookEvent', () => {
  it('verifies the Stripe signature and normalizes invoice.paid payloads', async () => {
    const provider = new StripePaymentsProvider('sk_test_123', 'https://example.com');
    const payload = JSON.stringify({
      id: 'evt_123',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_123',
          payment_intent: 'pi_123',
          hosted_invoice_url: 'https://invoice.example/in_123',
          amount_paid: 15000,
          currency: 'chf',
          customer: 'cus_123',
          metadata: {
            booking_id: 'booking_123',
          },
        },
      },
    });
    const signature = await stripeSignature('whsec_test', payload, '1742342400');

    const event = await provider.parseWebhookEvent(payload, signature, 'whsec_test');

    expect(event).toEqual({
      eventCategory: 'payment',
      eventType: 'invoice.paid',
      checkoutSessionId: null,
      paymentIntentId: 'pi_123',
      invoiceId: 'in_123',
      invoiceUrl: 'https://invoice.example/in_123',
      paymentLinkId: null,
      amount: 150,
      currency: 'CHF',
      bookingId: 'booking_123',
      customerId: 'cus_123',
      siteUrl: null,
      rawPayload: expect.objectContaining({
        type: 'invoice.paid',
      }),
    });
  });

  it('falls back to client_reference_id for checkout booking reconciliation', async () => {
    const provider = new StripePaymentsProvider('sk_test_123', 'https://example.com');
    const payload = JSON.stringify({
      id: 'evt_checkout_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_123',
          client_reference_id: 'booking_client_ref_123',
          amount_total: 15000,
          currency: 'chf',
          customer: 'cus_123',
          metadata: {},
        },
      },
    });
    const signature = await stripeSignature('whsec_test', payload, '1742342401');

    const event = await provider.parseWebhookEvent(payload, signature, 'whsec_test');

    expect(event?.bookingId).toBe('booking_client_ref_123');
  });
});

describe('StripePaymentsProvider.createCheckoutSession', () => {
  it('propagates booking metadata onto the checkout-created payment intent', async () => {
    const provider = new StripePaymentsProvider('sk_test_123', 'https://example.com');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cus_123',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cs_123',
        url: 'https://checkout.stripe.com/c/pay/cs_123',
        amount_total: 15000,
        currency: 'chf',
        customer: 'cus_123',
        payment_intent: 'pi_123',
      }), { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      await provider.createCheckoutSession({
        bookingId: 'booking_123',
        customerEmail: 'checkout@example.com',
        customerName: 'Checkout Customer',
        successUrl: 'https://example.com/payment-success?booking_id=booking_123',
        cancelUrl: 'https://example.com/payment-cancel?booking_id=booking_123',
        lineItems: [
          {
            name: 'Session',
            amount: 150,
            currency: 'CHF',
            quantity: 1,
          },
        ],
        metadata: {
          payment_kind: 'pay_now',
          booking_kind: 'session',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const checkoutCall = fetchMock.mock.calls[2];
    expect(checkoutCall?.[0]).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(String((checkoutCall?.[1] as RequestInit | undefined)?.body)).toContain('invoice_creation%5Benabled%5D=true');
    expect(String((checkoutCall?.[1] as RequestInit | undefined)?.body)).toContain('invoice_creation%5Binvoice_data%5D%5Bmetadata%5D%5Bbooking_id%5D=booking_123');
    expect(String((checkoutCall?.[1] as RequestInit | undefined)?.body)).toContain('payment_intent_data%5Bmetadata%5D%5Bbooking_id%5D=booking_123');
    expect(String((checkoutCall?.[1] as RequestInit | undefined)?.body)).toContain('payment_intent_data%5Bmetadata%5D%5Bpayment_kind%5D=pay_now');
  });

  it('creates direct refunds through the refunds API when only a payment intent is available', async () => {
    const provider = new StripePaymentsProvider('sk_test_123', 'https://example.com');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 're_123',
      status: 'pending',
      payment_intent: 'pi_123',
      amount: 15000,
      currency: 'chf',
    }), { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const refund = await provider.createRefund({
        bookingId: 'booking_123',
        paymentId: 'payment_123',
        amount: 150,
        currency: 'CHF',
        reasonText: 'Full refund initiated because cancellation happened before the lock window.',
        stripePaymentIntentId: 'pi_123',
      });

      expect(refund).toEqual(expect.objectContaining({
        refundPath: 'direct_refund',
        refundStatus: 'PENDING',
        refundId: 're_123',
        paymentIntentId: 'pi_123',
        amount: 150,
        currency: 'CHF',
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/refunds',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)).toContain('payment_intent=pi_123');
  });

  it('creates invoice-backed refunds through Stripe credit notes when an invoice id is available', async () => {
    const provider = new StripePaymentsProvider('sk_test_123', 'https://example.com');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cn_123',
        number: 'CN-2026-0001',
        invoice: 'in_123',
        amount: 15000,
        currency: 'chf',
        pdf: 'https://stripe.example/cn_123.pdf',
        refunds: [{ refund: 're_123' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 're_123',
        status: 'succeeded',
        payment_intent: 'pi_123',
        amount: 15000,
        currency: 'chf',
      }), { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const refund = await provider.createRefund({
        bookingId: 'booking_123',
        paymentId: 'payment_123',
        amount: 150,
        currency: 'CHF',
        reasonText: 'Full refund initiated because cancellation happened before the lock window.',
        stripeInvoiceId: 'in_123',
        stripePaymentIntentId: 'pi_123',
      });

      expect(refund).toEqual(expect.objectContaining({
        refundPath: 'credit_note',
        refundStatus: 'SUCCEEDED',
        refundId: 're_123',
        creditNoteId: 'cn_123',
        creditNoteNumber: 'CN-2026-0001',
        creditNoteDocumentUrl: 'https://stripe.example/cn_123.pdf',
        invoiceId: 'in_123',
        paymentIntentId: 'pi_123',
        amount: 150,
        currency: 'CHF',
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.stripe.com/v1/credit_notes');
    expect(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)).toContain('invoice=in_123');
    expect(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)).toContain('refund_amount=15000');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.stripe.com/v1/refunds/re_123');
  });

  it('normalizes refund.updated webhook payloads into refund reconciliation events', async () => {
    const provider = new StripePaymentsProvider('sk_test_123', 'https://example.com');
    const payload = JSON.stringify({
      id: 'evt_refund_123',
      type: 'refund.updated',
      data: {
        object: {
          id: 're_123',
          payment_intent: 'pi_123',
          status: 'succeeded',
          amount: 15000,
          currency: 'chf',
          metadata: {
            booking_id: 'booking_123',
            invoice_id: 'in_123',
          },
        },
      },
    });
    const signature = await stripeSignature('whsec_test', payload, '1742342402');

    const event = await provider.parseWebhookEvent(payload, signature, 'whsec_test');

    expect(event).toEqual({
      eventCategory: 'refund',
      eventType: 'refund.updated',
      refundId: 're_123',
      creditNoteId: null,
      creditNoteNumber: null,
      creditNoteDocumentUrl: null,
      paymentIntentId: 'pi_123',
      invoiceId: 'in_123',
      refundStatus: 'SUCCEEDED',
      amount: 150,
      currency: 'CHF',
      bookingId: 'booking_123',
      rawPayload: expect.objectContaining({
        type: 'refund.updated',
      }),
    });
  });

  it('normalizes credit_note.created payloads and ignores charge.refunded payloads', async () => {
    const provider = new StripePaymentsProvider('sk_test_123', 'https://example.com');
    const creditNotePayload = JSON.stringify({
      id: 'evt_credit_note_123',
      type: 'credit_note.created',
      data: {
        object: {
          id: 'cn_123',
          number: 'CN-2026-0001',
          invoice: 'in_123',
          amount: 15000,
          currency: 'chf',
          pdf: 'https://stripe.example/cn_123.pdf',
          refunds: [],
          metadata: {
            booking_id: 'booking_123',
          },
        },
      },
    });
    const chargeRefundedPayload = JSON.stringify({
      id: 'evt_charge_refunded_123',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_123',
          amount_refunded: 15000,
          currency: 'chf',
          metadata: {
            booking_id: 'booking_123',
          },
        },
      },
    });

    const creditNoteSignature = await stripeSignature('whsec_test', creditNotePayload, '1742342403');
    const chargeRefundedSignature = await stripeSignature('whsec_test', chargeRefundedPayload, '1742342404');

    const creditNoteEvent = await provider.parseWebhookEvent(creditNotePayload, creditNoteSignature, 'whsec_test');
    const ignoredChargeEvent = await provider.parseWebhookEvent(chargeRefundedPayload, chargeRefundedSignature, 'whsec_test');

    expect(creditNoteEvent).toEqual({
      eventCategory: 'refund',
      eventType: 'credit_note.created',
      refundId: null,
      creditNoteId: 'cn_123',
      creditNoteNumber: 'CN-2026-0001',
      creditNoteDocumentUrl: 'https://stripe.example/cn_123.pdf',
      paymentIntentId: null,
      invoiceId: 'in_123',
      refundStatus: null,
      amount: 150,
      currency: 'CHF',
      bookingId: 'booking_123',
      rawPayload: expect.objectContaining({
        type: 'credit_note.created',
      }),
    });
    expect(ignoredChargeEvent).toBeNull();
  });
});

async function stripeSignature(secret: string, payload: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const v1 = [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${v1}`;
}

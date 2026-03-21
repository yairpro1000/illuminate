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
    expect(String((checkoutCall?.[1] as RequestInit | undefined)?.body)).toContain('payment_intent_data%5Bmetadata%5D%5Bbooking_id%5D=booking_123');
    expect(String((checkoutCall?.[1] as RequestInit | undefined)?.body)).toContain('payment_intent_data%5Bmetadata%5D%5Bpayment_kind%5D=pay_now');
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

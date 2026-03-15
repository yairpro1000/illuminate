import { mockState, type SentEmail } from '../providers/mock-state.js';

export interface MockEmailPreview {
  email_id: string;
  to: string;
  subject: string;
  html_url: string;
}

interface PreviewContext {
  emailMode: string;
  apiOrigin: string;
}

function normalizeApiOrigin(apiOrigin: string): string {
  return apiOrigin.replace(/\/+$/g, '');
}

function toPreview(email: SentEmail, context: PreviewContext): MockEmailPreview {
  return {
    email_id: email.id,
    to: email.to,
    subject: email.subject,
    html_url: `${normalizeApiOrigin(context.apiOrigin)}/api/__dev/emails/${encodeURIComponent(email.id)}/html`,
  };
}

export function shouldExposeMockEmailPreview(emailMode: string): boolean {
  return String(emailMode || '').trim().toLowerCase() === 'mock';
}

export function resolveMockEmailPreviewById(
  emailId: string | null | undefined,
  context: PreviewContext,
): MockEmailPreview | null {
  if (!emailId || !shouldExposeMockEmailPreview(context.emailMode)) {
    return null;
  }

  const email = mockState.sentEmails.find((entry) => entry.id === emailId);
  return email ? toPreview(email, context) : null;
}

export function resolveLatestMockEmailPreviewForBooking(
  bookingId: string | null | undefined,
  context: PreviewContext,
  options: { emailKinds?: string[] } = {},
): MockEmailPreview | null {
  if (!bookingId || !shouldExposeMockEmailPreview(context.emailMode)) {
    return null;
  }

  const allowedKinds = new Set((options.emailKinds || []).filter(Boolean));
  for (let index = mockState.sentEmails.length - 1; index >= 0; index -= 1) {
    const email = mockState.sentEmails[index];
    if (!email || email.booking_id !== bookingId) {
      continue;
    }
    if (allowedKinds.size > 0 && !allowedKinds.has(email.email_kind || email.kind)) {
      continue;
    }
    return toPreview(email, context);
  }

  return null;
}

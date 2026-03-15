import { mockState, type SentEmail } from '../providers/mock-state.js';
import type { EmailDispatchState } from './execution.js';

export interface MockEmailPreview {
  email_id: string;
  to: string;
  subject: string;
  html_url: string;
  email_kind: string;
}

interface PreviewContext {
  emailMode: string;
  apiOrigin: string;
  uiTestMode: string | null;
}

export const UI_TEST_MODE_HEADER = 'x-illuminate-ui-test-mode';

export interface MockEmailPreviewDecision {
  uiTestMode: string | null;
  shouldExpose: boolean;
  branchTaken: string;
  denyReason: string | null;
}

interface DispatchResolutionContext {
  emailMode: string;
  apiOrigin: string;
  request: Request;
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
    email_kind: email.email_kind || email.kind,
  };
}

export function resolveUiTestMode(request: Request): string | null {
  const raw = request.headers.get(UI_TEST_MODE_HEADER);
  const normalized = String(raw || '').trim().toLowerCase();
  return normalized || null;
}

export function getMockEmailPreviewDecision(emailMode: string, request: Request): MockEmailPreviewDecision {
  const uiTestMode = resolveUiTestMode(request);
  const normalizedEmailMode = String(emailMode || '').trim().toLowerCase();

  if (normalizedEmailMode !== 'mock') {
    return {
      uiTestMode,
      shouldExpose: false,
      branchTaken: 'skip_mock_email_preview_email_mode_not_mock',
      denyReason: 'email_mode_not_mock',
    };
  }

  if (!uiTestMode) {
    return {
      uiTestMode: null,
      shouldExpose: false,
      branchTaken: 'skip_mock_email_preview_ui_test_mode_not_enabled',
      denyReason: 'ui_test_mode_not_enabled',
    };
  }

  return {
    uiTestMode,
    shouldExpose: true,
    branchTaken: 'allow_mock_email_preview_ui_test_mode',
    denyReason: null,
  };
}

export function shouldExposeMockEmailPreview(context: Pick<PreviewContext, 'emailMode' | 'uiTestMode'>): boolean {
  return String(context.emailMode || '').trim().toLowerCase() === 'mock' && Boolean(context.uiTestMode);
}

export function resolveEmailDispatchState(
  sendResult: { messageId?: unknown; debug?: Record<string, unknown> } | null | undefined,
  context: DispatchResolutionContext,
): EmailDispatchState {
  const decision = getMockEmailPreviewDecision(context.emailMode, context.request);
  const emailKind = typeof sendResult?.debug?.['kind'] === 'string' ? String(sendResult?.debug?.['kind']) : null;
  const messageId = typeof sendResult?.messageId === 'string' ? sendResult.messageId : null;

  if (!messageId) {
    return {
      messageId: null,
      emailKind,
      uiTestMode: decision.uiTestMode,
      mockEmailPreview: null,
      branchTaken: 'skip_mock_email_preview_message_id_missing',
      denyReason: 'email_message_id_missing',
    };
  }

  if (!decision.shouldExpose) {
    return {
      messageId,
      emailKind,
      uiTestMode: decision.uiTestMode,
      mockEmailPreview: null,
      branchTaken: decision.branchTaken,
      denyReason: decision.denyReason,
    };
  }

  const preview = resolveMockEmailPreviewById(messageId, {
    emailMode: context.emailMode,
    apiOrigin: context.apiOrigin,
    uiTestMode: decision.uiTestMode,
  });

  return {
    messageId,
    emailKind,
    uiTestMode: decision.uiTestMode,
    mockEmailPreview: preview,
    branchTaken: preview
      ? 'include_mock_email_preview'
      : 'skip_mock_email_preview_captured_email_missing',
    denyReason: preview ? null : 'captured_email_not_found_for_message_id',
  };
}

export function resolveMockEmailPreviewById(
  emailId: string | null | undefined,
  context: PreviewContext,
): MockEmailPreview | null {
  if (!emailId || !shouldExposeMockEmailPreview(context)) {
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
  if (!bookingId || !shouldExposeMockEmailPreview(context)) {
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

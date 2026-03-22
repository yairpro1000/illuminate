import type { Env } from '../env.js';
import { safeSelectMany, type TechnicalObservabilityRow } from './technical-observability-core.js';

export interface CapturedEmailRecord {
  id: string;
  from: string;
  to: string;
  subject: string;
  kind: string;
  email_kind: string;
  replyTo: string;
  text: string;
  html: string | null;
  sentAt: string;
  sent_at: string;
  booking_id: string | null;
  event_id: string | null;
  contact_message_id: string | null;
}

interface MockEmailDebugPayload {
  mock_email?: Partial<CapturedEmailRecord> | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseCapturedEmail(row: TechnicalObservabilityRow): CapturedEmailRecord | null {
  const responseBody = asObject(row.response_body_preview);
  const debug = asObject(responseBody?.['debug']) as MockEmailDebugPayload | null;
  const mockEmail = asObject(debug?.mock_email);
  if (!mockEmail) return null;

  const id = asString(mockEmail.id);
  const from = asString(mockEmail.from);
  const to = asString(mockEmail.to);
  const subject = asString(mockEmail.subject);
  const kind = asString(mockEmail.kind);
  const emailKind = asString(mockEmail.email_kind) ?? kind;
  const replyTo = asString(mockEmail.replyTo);
  const sentAt = asString(mockEmail.sentAt) ?? asString(mockEmail.sent_at);
  const text = asString(mockEmail.text);

  if (!id || !from || !to || !subject || !kind || !emailKind || !replyTo || !sentAt || text === null) {
    return null;
  }

  return {
    id,
    from,
    to,
    subject,
    kind,
    email_kind: emailKind,
    replyTo,
    text,
    html: asString(mockEmail.html),
    sentAt,
    sent_at: asString(mockEmail.sent_at) ?? sentAt,
    booking_id: asString(mockEmail.booking_id),
    event_id: asString(mockEmail.event_id),
    contact_message_id: asString(mockEmail.contact_message_id),
  };
}

export async function listRecentCapturedMockEmails(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  limit = 200,
): Promise<CapturedEmailRecord[]> {
  const rows = await safeSelectMany(env, 'api_logs', async (client) =>
    await client
      .from('api_logs')
      .select('id,created_at,response_body_preview,provider,direction')
      .eq('provider', 'email')
      .eq('direction', 'outbound')
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(limit, 500))),
  );

  const deduped = new Map<string, CapturedEmailRecord>();
  for (const row of rows) {
    const parsed = parseCapturedEmail(row);
    if (!parsed) continue;
    if (!deduped.has(parsed.id)) deduped.set(parsed.id, parsed);
  }

  return [...deduped.values()].sort((left, right) =>
    new Date(right.sent_at).getTime() - new Date(left.sent_at).getTime(),
  );
}

export async function findCapturedMockEmailById(
  emailId: string,
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
): Promise<CapturedEmailRecord | null> {
  const emails = await listRecentCapturedMockEmails(env, 500);
  return emails.find((email) => email.id === emailId) ?? null;
}

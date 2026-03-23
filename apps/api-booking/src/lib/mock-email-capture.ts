import type { Env } from '../env.js';
import { mockState } from '../providers/mock-state.js';

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

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function toCapturedEmailRecord(row: Record<string, unknown>): CapturedEmailRecord | null {
  const id = asString(row.id);
  const from = asString(row.from);
  const to = asString(row.to);
  const subject = asString(row.subject);
  const kind = asString(row.kind);
  const emailKind = asString(row.email_kind) ?? kind;
  const replyTo = asString(row.replyTo);
  const sentAt = asString(row.sentAt) ?? asString(row.sent_at);
  const text = asString(row.text);

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
    html: asString(row.html),
    sentAt,
    sent_at: asString(row.sent_at) ?? sentAt,
    booking_id: asString(row.booking_id),
    event_id: asString(row.event_id),
    contact_message_id: asString(row.contact_message_id),
  };
}

export async function listRecentCapturedMockEmails(
  _env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  limit = 200,
): Promise<CapturedEmailRecord[]> {
  const deduped = new Map<string, CapturedEmailRecord>();
  const rows = mockState.sentEmails
    .slice()
    .reverse()
    .slice(0, Math.max(1, Math.min(limit, 500)));

  for (const row of rows) {
    const parsed = toCapturedEmailRecord(row as unknown as Record<string, unknown>);
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

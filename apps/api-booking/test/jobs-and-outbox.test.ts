import { describe, it, expect, vi } from 'vitest';
import { runCron, runPaymentDueReminders, runPaymentDueCancellations, runCheckoutExpiry, runSideEffectsOutbox } from '../src/handlers/jobs.js';

function makeCtx(overrides: any = {}) {
  const providers = {
    repository: {
      getPaymentDueRemindersDue: vi.fn().mockResolvedValue([]),
      getPaymentDueCancellationsDue: vi.fn().mockResolvedValue([]),
      getExpiredBookingHolds: vi.fn().mockResolvedValue([]),
      getUnconfirmedBookingFollowupsDue: vi.fn().mockResolvedValue([]),
      get24hBookingRemindersDue: vi.fn().mockResolvedValue([]),
      getCalendarSyncFailuresDue: vi.fn().mockResolvedValue([]),
      resolveCalendarSyncFailure: vi.fn().mockResolvedValue(undefined),
      enqueueSideEffect: vi.fn().mockResolvedValue({ id: 'se1' }),
      markSideEffect: vi.fn().mockResolvedValue(undefined),
      getPendingSideEffects: vi.fn().mockResolvedValue([]),
      updateBooking: vi.fn().mockResolvedValue({ id: 'b1' }),
      getBookingById: vi.fn().mockResolvedValue(null),
      logFailure: vi.fn().mockResolvedValue(undefined),
      getEventById: vi.fn().mockResolvedValue(null),
      getPaymentByBookingId: vi.fn().mockResolvedValue({ checkout_url: 'https://checkout' }),
    },
    email: {
      sendBookingPaymentReminder: vi.fn().mockResolvedValue(undefined),
      sendBookingCancellation: vi.fn().mockResolvedValue(undefined),
      sendBookingConfirmRequest: vi.fn().mockResolvedValue(undefined),
    },
    calendar: {
      createEvent: vi.fn().mockResolvedValue({ eventId: 'g1' }),
      updateEvent: vi.fn().mockResolvedValue(undefined),
      deleteEvent: vi.fn().mockResolvedValue(undefined),
      getBusyTimes: vi.fn().mockResolvedValue([]),
    },
  };
  const mergedRepo = { ...providers.repository, ...((overrides.providers && overrides.providers.repository) || {}) };
  const mergedProviders = { ...providers, ...(overrides.providers || {}), repository: mergedRepo };
  const ctx = {
    providers: mergedProviders,
    env: { SITE_URL: 'https://example.com' },
    logger: { logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), error: vi.fn(), warn: vi.fn() },
    requestId: 'req',
    triggerSource: 'manual',
  } as any;
  return ctx;
}

describe('Jobs and outbox', () => {
  it('enqueues 36h payment reminder side effects', async () => {
    const b = { id: 'b1', source: 'session' } as any;
    const ctx = makeCtx({ providers: { repository: { getPaymentDueRemindersDue: vi.fn().mockResolvedValue([b]) } } });
    await runPaymentDueReminders(ctx);
    expect(ctx.providers.repository.enqueueSideEffect).toHaveBeenCalledWith(expect.objectContaining({
      booking_id: 'b1',
      effect_type: 'email.payment_reminder.session',
    }));
  });

  it('expires pending holds by calling updateBooking via expireBooking', async () => {
    const b = { id: 'b2' } as any;
    const ctx = makeCtx({ providers: { repository: { getExpiredBookingHolds: vi.fn().mockResolvedValue([b]) } } });
    await expect(runCheckoutExpiry(ctx)).resolves.toBeUndefined();
    expect(ctx.providers.repository.getExpiredBookingHolds).toHaveBeenCalled();
  });

  it('enqueues side effects and dispatches them', async () => {
    const b = { id: 'b3', source: 'session', manage_token_hash: 'h' } as any;
    const eff = { id: 'e1', booking_id: 'b3', effect_type: 'email.payment_reminder.session', payload: {} };
    const ctx = makeCtx({ providers: { repository: {
      getPendingSideEffects: vi.fn().mockResolvedValue([eff]),
      getBookingById: vi.fn().mockResolvedValue(b),
      updateBooking: vi.fn().mockResolvedValue(b),
    } } });
    await runSideEffectsOutbox(ctx);
    expect(ctx.providers.repository.markSideEffect).toHaveBeenCalledWith('e1', 'done', null);
  });

  it('cancels pay-later at deadline', async () => {
    const b = { id: 'b4' } as any;
    const ctx = makeCtx({ providers: { repository: { getPaymentDueCancellationsDue: vi.fn().mockResolvedValue([b]) } } });
    await expect(runPaymentDueCancellations(ctx)).resolves.toBeUndefined();
    expect(ctx.providers.repository.getPaymentDueCancellationsDue).toHaveBeenCalled();
  });

  it('runs unified cron sweep for supported expression', async () => {
    const ctx = makeCtx();
    await expect(runCron('* * * * *', ctx)).resolves.toBeUndefined();

    expect(ctx.providers.repository.getExpiredBookingHolds).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.getUnconfirmedBookingFollowupsDue).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.getPaymentDueCancellationsDue).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.getPaymentDueRemindersDue).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.get24hBookingRemindersDue).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.getPendingSideEffects).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.getCalendarSyncFailuresDue).toHaveBeenCalledWith(100);
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cron_dispatch_decision',
      context: expect.objectContaining({
        received_cron_expression: '* * * * *',
        branch_taken: 'run_unified_sweep',
      }),
    }));
  });

  it('logs concrete deny reason for unsupported cron expression', async () => {
    const ctx = makeCtx();
    await expect(runCron('*/5 * * * *', ctx)).resolves.toBeUndefined();

    expect(ctx.providers.repository.getExpiredBookingHolds).not.toHaveBeenCalled();
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cron_dispatch_rejected',
      context: expect.objectContaining({
        received_cron_expression: '*/5 * * * *',
        deny_reason: 'unsupported_cron_expression',
      }),
    }));
  });
});

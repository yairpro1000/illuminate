(function () {
  'use strict';

  async function submitBooking(args) {
    const payload = {
      slot_start: args.state.selectedSlot.start,
      slot_end: args.state.selectedSlot.end,
      timezone: args.config.timezone || 'Europe/Zurich',
      type: args.context.slotType,
      client_name: [args.state.firstName, args.state.lastName].filter(Boolean).join(' '),
      client_email: args.state.email.trim(),
      client_phone: args.state.phone.trim() || null,
      reminder_email_opt_in: true,
      reminder_whatsapp_opt_in: false,
      turnstile_token: args.config.turnstilePlaceholderToken || 'placeholder',
    };

    let result;
    if (args.isIntroFlow()) {
      if (args.observability) args.observability.logMilestone('confirmation_email_requested', { flow: 'site_booking_intro', slot_start: payload.slot_start });
      result = await bookingPayLater(payload);
    } else if (args.state.paymentMethod === 'pay-now') {
      if (args.observability) args.observability.logMilestone('checkout_started', { flow: 'site_booking_pay_now', slot_start: payload.slot_start });
      result = await bookingPayNow(payload);
    } else {
      if (args.observability) args.observability.logMilestone('confirmation_email_requested', { flow: 'site_booking_pay_later', slot_start: payload.slot_start });
      result = await bookingPayLater(payload);
    }

    console.log('[Book] Booking result:', result);
    if (args.observability) args.observability.logMilestone('booking_created', { booking_id: result.booking_id, payment_method: args.state.paymentMethod });
    return result;
  }

  async function submitReschedule(args) {
    if (!args.state.selectedSlot) throw new Error('Please choose a new slot.');
    if (!args.context.manageToken || !args.context.bookingId) throw new Error('Missing reschedule token.');

    const payload = {
      token: args.context.manageToken,
      new_start: args.state.selectedSlot.start,
      new_end: args.state.selectedSlot.end,
      timezone: args.config.timezone || 'Europe/Zurich',
      ...(args.context.adminToken ? { admin_token: args.context.adminToken } : {}),
    };

    if (args.observability) args.observability.logMilestone('checkout_started', { flow: 'site_reschedule', booking_id: args.context.bookingId });
    const result = await bookingReschedule(payload);
    console.log('[Book] Reschedule result:', result);
    if (args.observability) args.observability.logMilestone('booking_rescheduled', { booking_id: result.booking_id });
    return result;
  }

  async function submitEventRegistration(args) {
    const payload = {
      first_name: args.state.firstName.trim(),
      last_name: args.state.lastName.trim() || null,
      email: args.state.email.trim(),
      phone: args.state.phone.trim() || null,
      reminder_email_opt_in: true,
      reminder_whatsapp_opt_in: false,
      turnstile_token: args.config.turnstilePlaceholderToken || 'placeholder',
    };

    if (args.observability) args.observability.logMilestone('registration_started', { event_slug: args.context.eventSlug });
    const result = args.context.eventAccessToken
      ? await eventBookWithAccess(args.context.eventSlug, Object.assign({ access_token: args.context.eventAccessToken }, payload))
      : await eventBook(args.context.eventSlug, payload);
    console.log('[Book] Event registration result:', result);
    if (args.observability) args.observability.logMilestone('registration_created', { booking_id: result.booking_id, event_slug: args.context.eventSlug });
    return result;
  }

  async function loadRescheduleContext(args) {
    if (args.context.mode !== 'reschedule') return;
    if (!args.context.manageToken || !args.context.bookingId) throw new Error('Invalid reschedule link.');

    const params = new URLSearchParams({ token: args.context.manageToken });
    if (args.context.adminToken) params.set('admin_token', args.context.adminToken);
    const data = await _get('/api/bookings/manage?' + params.toString());
    args.state.currentBooking = data;
    args.state.firstName = data.client?.first_name || '';
    args.state.lastName = data.client?.last_name || '';
    args.state.email = data.client?.email || '';
    args.state.phone = data.client?.phone || '';

    if (data.starts_at && data.ends_at) {
      const existing = { start: data.starts_at, end: data.ends_at };
      args.state.selectedSlot = existing;
      const d = new Date(existing.start);
      args.state.calViewDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
  }

  async function loadPublicConfig(args) {
    try {
      const data = await getPublicConfig();
      const minutes = Number(data && data.booking_policy && data.booking_policy.non_paid_confirmation_window_minutes);
      const validConfig = Number.isFinite(minutes) && minutes > 0;
      args.state.publicConfig = validConfig ? data : null;

      if (!validConfig) {
        console.warn('[Book] Public config returned invalid booking policy:', data);
        if (args.observability) {
          args.observability.logError({
            eventType: 'public_config_invalid',
            message: 'Public booking policy config is invalid',
            context: {
              branch_taken: 'deny_invalid_public_booking_policy_payload',
              deny_reason: 'non_paid_confirmation_window_minutes_invalid',
            },
          });
        }
        return;
      }

      if (args.observability) {
        args.observability.logMilestone('public_config_loaded', {
          config_version: data.config_version || null,
          non_paid_confirmation_window_minutes: minutes,
        });
      }
    } catch (err) {
      console.warn('[Book] Failed to load public config:', err);
      args.state.publicConfig = null;
      if (args.observability) {
        args.observability.logError({
          eventType: 'public_config_load_failed',
          message: err && err.message ? err.message : 'Public config request failed',
        });
      }
    }
  }

  window.BookPageEffects = {
    submitBooking,
    submitReschedule,
    submitEventRegistration,
    loadRescheduleContext,
    loadPublicConfig,
  };
})();

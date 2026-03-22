(async function () {
  'use strict';
  const siteClient = window.siteClient || null;
  const params     = new URLSearchParams(window.location.search);
  const sessionId  = params.get('session_id');
  const bookingId  = params.get('booking_id');
  const token = params.get('token');
  const bookingEventType = params.get('booking_event_type');
  const amount     = params.get('amount');
  const currency   = (params.get('currency') || 'CHF').toUpperCase();

  const detail = document.getElementById('dev-detail');
  if (amount) {
    const parsedAmount = Number(amount);
    const chf = Number.isFinite(parsedAmount) ? parsedAmount.toFixed(2) : amount;
    detail.textContent = `Amount: ${currency} ${chf} · Session: ${sessionId}`;
  } else {
    detail.textContent = `Session: ${sessionId}`;
  }

  async function simulate(result) {
    const btn = result === 'success'
      ? document.getElementById('btn-success')
      : document.getElementById('btn-fail');
    btn.disabled = true;
    btn.textContent = 'Processing…';

    try {
      await siteClient.requestJson(
        `/api/__dev/simulate-payment?session_id=${encodeURIComponent(sessionId)}&result=${result}`,
        { method: 'POST' },
      );

      if (result === 'success') {
        const successParams = new URLSearchParams({ session_id: sessionId });
        if (bookingId) successParams.set('booking_id', bookingId);
        if (token) successParams.set('token', token);
        if (bookingEventType) successParams.set('booking_event_type', bookingEventType);
        window.location.href = 'payment-success.html?' + successParams.toString();
      } else {
        const cancelParams = new URLSearchParams();
        if (bookingId) cancelParams.set('booking_id', bookingId);
        window.location.href = 'payment-cancel.html' + (cancelParams.size > 0 ? `?${cancelParams.toString()}` : '');
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = result === 'success' ? '✓ Simulate payment success' : '✗ Simulate payment failure';
      alert('Error: ' + (err.message || 'Unknown'));
    }
  }

  document.getElementById('btn-success').addEventListener('click', () => simulate('success'));
  document.getElementById('btn-fail').addEventListener('click',    () => simulate('failure'));
})();

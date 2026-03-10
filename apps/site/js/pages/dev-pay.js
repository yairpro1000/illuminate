(async function () {
  'use strict';
  const API_BASE = window.getSiteApiBase ? window.getSiteApiBase() : (window.API_BASE || '');
  const params     = new URLSearchParams(window.location.search);
  const sessionId  = params.get('session_id');
  const amount     = params.get('amount');
  const currency   = (params.get('currency') || 'CHF').toUpperCase();

  const detail = document.getElementById('dev-detail');
  if (amount) {
    const chf = (parseInt(amount, 10) / 100).toFixed(2);
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
      const res = await fetch(
        `${API_BASE}/api/__dev/simulate-payment?session_id=${encodeURIComponent(sessionId)}&result=${result}`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Error');

      if (result === 'success') {
        window.location.href = 'payment-success?session_id=' + encodeURIComponent(sessionId);
      } else {
        window.location.href = 'payment-cancel?session_id=' + encodeURIComponent(sessionId);
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

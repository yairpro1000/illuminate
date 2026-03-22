(async function () {
  'use strict';
  const siteClient = window.siteClient || null;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const adminToken = params.get('admin_token');
  const card = document.getElementById('continue-payment-card');
  const homepageHref = siteClient && typeof siteClient.resolveHomepageHref === 'function'
    ? siteClient.resolveHomepageHref()
    : (function () {
        try { return new URL('/index.html', window.location.origin).toString(); } catch (_) { return 'index.html'; }
      }());

  function renderFallback(title, message) {
    if (!card) return;
    card.innerHTML = `
      <h1 class="result-title">${title}</h1>
      <p class="result-msg">${message}</p>
      <div class="result-actions">
        <a href="contact.html" class="btn btn-primary">Contact Yair</a>
        <a href="${homepageHref}" class="btn btn-ghost">← Homepage</a>
      </div>
    `;
  }

  if (!card) return;
  if (!token) {
    renderFallback('Missing payment link', 'This payment link is missing required information.');
    return;
  }

  try {
    const query = new URLSearchParams({ token });
    if (adminToken) query.set('admin_token', adminToken);
    const data = await siteClient.requestJson(`/api/bookings/continue-payment?${query.toString()}`);
    if (data.action_url) {
      window.location.href = data.action_url;
      return;
    }
    renderFallback('Payment unavailable', 'This booking can no longer continue to payment online.');
  } catch (err) {
    renderFallback(
      'Could not continue to payment',
      (err && err.message) || 'Please use your manage link or contact Yair directly.',
    );
  }
})();

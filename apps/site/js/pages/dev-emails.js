(async function () {
  'use strict';
  const siteClient = window.siteClient || null;
  const content = document.getElementById('content');

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      day: 'numeric', month: 'short',
    });
  }

  async function load() {
    content.innerHTML = '<p style="color:#aaa">Loading…</p>';
    try {
      const data = await siteClient.requestJson('/api/__dev/emails');
      const emails = data.emails || [];

      if (!emails.length) {
        content.innerHTML = '<div class="empty">No emails sent yet.<br>Complete a booking or registration to see emails here.</div>';
        return;
      }

      content.innerHTML = '<div class="email-list">' +
        emails.map(e => `
          <div class="email-card">
            <div class="email-header">
              <span class="email-kind">${e.kind.replace(/_/g, ' ')}</span>
              <span class="email-subject">${e.subject}</span>
              <span class="email-to">To: ${e.to}</span>
              <span class="email-time">${formatTime(e.sentAt)}</span>
            </div>
            <div class="email-body">Preview redacted in dev summary. Open the mail provider mock or logs if you need full content.</div>
          </div>
        `).join('') +
        '</div>';
    } catch (err) {
      content.innerHTML = `<div class="empty" style="color:oklch(50% 0.15 25)">Error: ${err.message}</div>`;
    }
  }

  document.getElementById('refresh-btn').addEventListener('click', load);
  load();
})();

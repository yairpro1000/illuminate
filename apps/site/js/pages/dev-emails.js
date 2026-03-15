(async function () {
  'use strict';

  const siteClient = window.siteClient || null;
  const content = document.getElementById('content');
  const searchParams = new URLSearchParams(window.location.search);
  const requestedEmailId = searchParams.get('email_id');

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      day: 'numeric', month: 'short',
    });
  }

  function createPreview(selectedEmail) {
    const shell = document.createElement('section');
    shell.className = 'email-preview-shell';

    const header = document.createElement('div');
    header.className = 'email-preview-header';

    const meta = document.createElement('div');
    meta.className = 'email-preview-meta';

    const title = document.createElement('p');
    title.className = 'email-preview-title';
    title.textContent = selectedEmail.subject;
    meta.appendChild(title);

    const to = document.createElement('p');
    to.className = 'email-preview-to';
    to.textContent = `To: ${selectedEmail.to}`;
    meta.appendChild(to);

    const link = document.createElement('a');
    link.className = 'email-preview-link';
    link.href = selectedEmail.preview_html_url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Open raw preview';

    header.appendChild(meta);
    header.appendChild(link);

    const frame = document.createElement('iframe');
    frame.className = 'email-preview-frame';
    frame.title = `Email preview: ${selectedEmail.subject}`;
    frame.src = selectedEmail.preview_html_url;

    shell.appendChild(header);
    shell.appendChild(frame);
    return shell;
  }

  function renderEmails(emails) {
    const selectedEmail = emails.find((email) => email.id === requestedEmailId) || emails[0];
    const layout = document.createElement('div');
    layout.className = 'email-layout';

    const sidebar = document.createElement('div');
    sidebar.className = 'email-sidebar';

    const list = document.createElement('div');
    list.className = 'email-list';

    const previewHost = document.createElement('div');

    function selectEmail(email, card) {
      list.querySelectorAll('.email-card').forEach((element) => element.classList.remove('is-active'));
      card.classList.add('is-active');
      previewHost.innerHTML = '';
      previewHost.appendChild(createPreview(email));
      const url = new URL(window.location.href);
      url.searchParams.set('email_id', email.id);
      window.history.replaceState({}, '', url);
    }

    emails.forEach((email) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'email-card';
      card.dataset.emailId = email.id;
      card.setAttribute('aria-label', `Preview ${email.subject}`);

      card.innerHTML = `
        <div class="email-header">
          <span class="email-kind">${email.kind.replace(/_/g, ' ')}</span>
          <span class="email-subject">${email.subject}</span>
          <span class="email-to">To: ${email.to}</span>
          <span class="email-time">${formatTime(email.sentAt)}</span>
        </div>
        <div class="email-body">${email.has_html ? 'Captured HTML preview available.' : 'Plain-text email captured.'}</div>
      `;

      card.addEventListener('click', () => selectEmail(email, card));
      list.appendChild(card);

      if (email.id === selectedEmail.id) {
        card.classList.add('is-active');
      }
    });

    sidebar.appendChild(list);
    previewHost.appendChild(createPreview(selectedEmail));
    layout.appendChild(sidebar);
    layout.appendChild(previewHost);
    content.innerHTML = '';
    content.appendChild(layout);
  }

  async function load() {
    content.innerHTML = '<p style="color:#aaa">Loading…</p>';
    try {
      const data = await siteClient.requestJson('/api/__dev/emails');
      const emails = Array.isArray(data.emails) ? data.emails : [];

      if (!emails.length) {
        content.innerHTML = '<div class="empty">No emails sent yet.<br>Complete a booking or registration to see emails here.</div>';
        return;
      }

      renderEmails(emails);
    } catch (err) {
      content.innerHTML = `<div class="empty" style="color:oklch(50% 0.15 25)">Error: ${err.message}</div>`;
    }
  }

  document.getElementById('refresh-btn').addEventListener('click', load);
  load();
})();

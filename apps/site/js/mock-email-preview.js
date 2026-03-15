(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function ensureStyles() {
    if (document.getElementById('mock-email-preview-styles')) return;

    const style = document.createElement('style');
    style.id = 'mock-email-preview-styles';
    style.textContent = `
      .site-mock-email-preview-surface {
        width: 100% !important;
        max-width: min(1120px, 96vw) !important;
        text-align: left !important;
      }
      .mock-email-preview {
        display: grid;
        gap: 1rem;
      }
      .mock-email-preview__title {
        margin: 0;
        color: var(--color-text);
      }
      .mock-email-preview__message {
        margin: 0;
        color: var(--color-text-muted);
        line-height: 1.6;
      }
      .mock-email-preview__meta {
        display: flex;
        flex-wrap: wrap;
        gap: .5rem 1rem;
        color: var(--color-text-muted);
        font-size: .95rem;
      }
      .mock-email-preview__frame {
        width: 100%;
        min-height: 720px;
        border: 1px solid var(--color-border);
        border-radius: 1rem;
        background: #fff;
      }
      .mock-email-preview__actions {
        display: flex;
        flex-wrap: wrap;
        gap: .75rem;
      }
    `;
    document.head.appendChild(style);
  }

  function render(args) {
    const container = args && args.container;
    const preview = args && args.preview;
    if (!container || !preview || !preview.html_url) return false;

    ensureStyles();
    container.classList.add('site-mock-email-preview-surface');

    const title = args.title || 'Sent email preview';
    const message = args.message || 'Test mode is active. This email was captured instead of being delivered.';
    const primaryAction = args.primaryAction || null;
    const secondaryAction = args.secondaryAction || null;
    const openLabel = args.openLabel || 'Open raw email';

    container.innerHTML = `
      <div class="mock-email-preview">
        <h2 class="mock-email-preview__title">${escapeHtml(title)}</h2>
        <p class="mock-email-preview__message">${escapeHtml(message)}</p>
        <div class="mock-email-preview__meta">
          <span><strong>To:</strong> ${escapeHtml(preview.to || '—')}</span>
          <span><strong>Subject:</strong> ${escapeHtml(preview.subject || '—')}</span>
        </div>
        <iframe
          class="mock-email-preview__frame"
          src="${escapeHtml(preview.html_url)}"
          title="${escapeHtml(preview.subject || title)}"
        ></iframe>
        <div class="mock-email-preview__actions">
          <a href="${escapeHtml(preview.html_url)}" class="btn btn-ghost" target="_blank" rel="noopener">${escapeHtml(openLabel)}</a>
          ${primaryAction && primaryAction.href ? `<a href="${escapeHtml(primaryAction.href)}" class="btn btn-primary">${escapeHtml(primaryAction.text || 'Continue')}</a>` : ''}
          ${secondaryAction && secondaryAction.href ? `<a href="${escapeHtml(secondaryAction.href)}" class="btn btn-ghost">${escapeHtml(secondaryAction.text || 'Back')}</a>` : ''}
        </div>
      </div>
    `;

    return true;
  }

  window.SiteMockEmailPreview = {
    render: render,
    escapeHtml: escapeHtml,
  };
})();

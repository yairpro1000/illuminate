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
      .mock-email-preview-overlay {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: min(2rem, 3vw);
        overflow: auto;
        background: rgba(7, 11, 16, 0.62);
        backdrop-filter: blur(10px);
      }
      .mock-email-preview-overlay[hidden] {
        display: none !important;
      }
      .site-mock-email-preview-surface,
      .mock-email-preview-overlay__card {
        width: 100% !important;
        max-width: min(1120px, 96vw) !important;
        text-align: left !important;
      }
      .mock-email-preview-overlay__card {
        position: relative;
        padding: clamp(1rem, 2vw, 1.5rem);
        border-radius: 1rem;
        border: 1px solid var(--color-border, rgba(255,255,255,0.16));
        background: var(--color-bg-card, #121820);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      }
      .mock-email-preview-overlay__dismiss {
        position: absolute;
        top: 0.75rem;
        right: 0.75rem;
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
        border: 1px solid var(--color-border, rgba(255,255,255,0.16));
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

  function getDefaultTitle(preview) {
    const kind = String(preview && preview.email_kind || '').trim().toLowerCase();
    switch (kind) {
      case 'contact_message':
        return 'Message sent';
      case 'event_confirm_request':
        return 'Registration received';
      case 'booking_confirm_request':
        return 'Booking received';
      case 'booking_cancellation':
        return 'Cancelled';
      case 'booking_confirmation':
      case 'event_confirmation':
        return 'Confirmed!';
      default:
        return 'Sent email preview';
    }
  }

  function getDefaultMessage(preview) {
    const kind = String(preview && preview.email_kind || '').trim().toLowerCase();
    switch (kind) {
      case 'contact_message':
        return 'Mock email mode is active. This captured contact email is rendered here instead of being delivered.';
      case 'booking_cancellation':
        return 'Mock email mode is active. This captured cancellation email is rendered here instead of being delivered.';
      default:
        return 'Mock email mode is active. This captured email is rendered here instead of being delivered.';
    }
  }

  function getOverlayHost() {
    let overlay = document.getElementById('mock-email-preview-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'mock-email-preview-overlay';
    overlay.className = 'mock-email-preview-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="mock-email-preview-overlay__card">
        <button type="button" class="btn btn-ghost mock-email-preview-overlay__dismiss" aria-label="Close email preview">Close</button>
        <div class="mock-email-preview-overlay__content"></div>
      </div>
    `;
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) overlay.hidden = true;
    });
    overlay.querySelector('.mock-email-preview-overlay__dismiss').addEventListener('click', function () {
      overlay.hidden = true;
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function createRawEmailUrl(preview) {
    if (!preview || !preview.html_content) {
      return preview && preview.html_url ? String(preview.html_url) : '';
    }

    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      var blob = new Blob([String(preview.html_content)], { type: 'text/html;charset=utf-8' });
      return URL.createObjectURL(blob);
    }

    return 'data:text/html;charset=utf-8,' + encodeURIComponent(String(preview.html_content));
  }

  function render(args) {
    const preview = args && args.preview;
    if (!preview || (!preview.html_content && !preview.html_url)) return false;

    ensureStyles();

    const overlay = !args || !args.container ? getOverlayHost() : null;
    const container = args && args.container
      ? args.container
      : overlay.querySelector('.mock-email-preview-overlay__content');
    if (!container) return false;

    container.classList.add('site-mock-email-preview-surface');

    const title = args && args.title ? args.title : getDefaultTitle(preview);
    const message = args && args.message ? args.message : getDefaultMessage(preview);
    const primaryAction = args && args.primaryAction ? args.primaryAction : null;
    const secondaryAction = args && args.secondaryAction ? args.secondaryAction : null;
    const openLabel = args && args.openLabel ? args.openLabel : 'Open raw email';

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

    var frame = container.querySelector('.mock-email-preview__frame');
    if (frame) {
      if (preview.html_content) {
        frame.srcdoc = String(preview.html_content);
      } else if (preview.html_url) {
        frame.src = String(preview.html_url);
      }
    }

    var rawLink = container.querySelector('.mock-email-preview__actions a');
    if (rawLink) {
      if (preview.html_content) {
        rawLink.href = createRawEmailUrl(preview);
      } else if (preview.html_url) {
        rawLink.href = String(preview.html_url);
      }
    }

    if (overlay) overlay.hidden = false;
    return true;
  }

  const api = {
    render: render,
    escapeHtml: escapeHtml,
    getDefaultTitle: getDefaultTitle,
    getDefaultMessage: getDefaultMessage,
  };

  window.IlluminateMockEmailPreview = api;
  window.SiteMockEmailPreview = api;
})();

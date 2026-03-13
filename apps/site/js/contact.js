/* ============================================================
   ILLUMINATE — Contact form
   POST /api/contact  { first_name, last_name?, email, topic?, message, turnstile_token }
   ============================================================ */

'use strict';

(function () {
  const OBS = window.siteObservability || null;
  const SITE_CLIENT = window.siteClient || null;
  const SITE_CONFIG = SITE_CLIENT && SITE_CLIENT.config ? SITE_CLIENT.config : {};

  const form       = document.getElementById('contact-form');
  const formWrap   = document.getElementById('contact-form-wrap');
  const successEl  = document.getElementById('contact-success');
  const submitBtn  = document.getElementById('contact-submit-btn');
  const submitErr  = document.getElementById('contact-submit-error');

  if (!form) return;

  /* ── Validation helpers ──────────────────────────────────── */

  function getField(name) {
    return form.elements[name];
  }

  function showError(fieldName, message) {
    const field = getField(fieldName);
    const err   = document.getElementById('contact-' + fieldName + '-error');
    if (!field || !err) return;
    field.classList.add('form-input--error');
    err.textContent = message;
    err.hidden = false;
  }

  function clearError(fieldName) {
    const field = getField(fieldName);
    const err   = document.getElementById('contact-' + fieldName + '-error');
    if (!field || !err) return;
    field.classList.remove('form-input--error');
    err.hidden = true;
    err.textContent = '';
  }

  function validate() {
    let ok = true;

    const firstName = getField('first_name').value.trim();
    const email     = getField('email').value.trim();
    const message   = getField('message').value.trim();

    clearError('first_name');
    clearError('email');
    clearError('message');

    if (!firstName) {
      showError('first_name', 'Please enter your first name.');
      ok = false;
    }

    if (!email) {
      showError('email', 'Please enter your email address.');
      ok = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError('email', 'Please enter a valid email address.');
      ok = false;
    }

    if (!message) {
      showError('message', 'Please write a message.');
      ok = false;
    }

    return ok;
  }

  /* ── Inline error clearing on input ─────────────────────── */

  ['first_name', 'email', 'message'].forEach(function (name) {
    const el = getField(name);
    if (el) el.addEventListener('input', function () { clearError(name); });
  });

  /* ── Submit ──────────────────────────────────────────────── */

  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    submitErr.hidden = true;

    if (!validate()) {
      // Focus the first invalid field
      const firstErr = form.querySelector('.form-input--error');
      if (firstErr) firstErr.focus();
      return;
    }

    const firstName = getField('first_name').value.trim();
    const lastName  = getField('last_name').value.trim();
    const email     = getField('email').value.trim();
    const topic     = getField('topic').value;
    const message   = getField('message').value.trim();

    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.textContent = 'Sending…';
    if (OBS && OBS.startFlow) OBS.startFlow('contact_flow_started');
    if (OBS) OBS.logMilestone('contact_submission_started', { flow: 'site_contact_form' });

    try {
      await _post('/api/contact', {
        first_name: firstName,
        last_name:  lastName || null,
        email,
        topic: topic || null,
        message,
        turnstile_token: SITE_CONFIG.turnstilePlaceholderToken || 'placeholder',
      });

      // Show success
      if (OBS) OBS.logMilestone('contact_message_submitted', { flow: 'site_contact_form' });
      formWrap.hidden = true;
      successEl.hidden = false;
      successEl.focus();

    } catch (err) {
      if (OBS) {
        OBS.logError({
          eventType: 'handled_exception',
          message: 'Contact form submission failed',
          error: {
            errorName: err && err.name || 'Error',
            stackTrace: err && err.stack || null,
            extra: { flow: 'site_contact_form' },
          },
        });
      }
      submitErr.hidden = false;
      submitErr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      submitBtn.removeAttribute('aria-busy');
      submitBtn.textContent = 'Send message';
    }
  });

})();

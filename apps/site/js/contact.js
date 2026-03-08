/* ============================================================
   ILLUMINATE — Contact form
   POST /api/contact  { name, email, message, turnstile_token }
   ============================================================ */

'use strict';

(function () {

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

    const name    = getField('name').value.trim();
    const email   = getField('email').value.trim();
    const message = getField('message').value.trim();

    clearError('name');
    clearError('email');
    clearError('message');

    if (!name) {
      showError('name', 'Please enter your name.');
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

  ['name', 'email', 'message'].forEach(function (name) {
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

    const name    = getField('name').value.trim();
    const email   = getField('email').value.trim();
    const topic   = getField('topic').value;
    const rawMsg  = getField('message').value.trim();

    // Prepend topic to the message so the backend can include it
    const message = topic
      ? 'Topic: ' + topic + '\n\n' + rawMsg
      : rawMsg;

    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.textContent = 'Sending…';

    try {
      await _post('/api/contact', {
        name,
        email,
        message,
        turnstile_token: 'placeholder',
      });

      // Show success
      formWrap.hidden = true;
      successEl.hidden = false;
      successEl.focus();

    } catch (err) {
      submitErr.hidden = false;
      submitErr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      submitBtn.removeAttribute('aria-busy');
      submitBtn.textContent = 'Send message';
    }
  });

})();

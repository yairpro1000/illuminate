(function initTurnstileTestPage() {
  'use strict';

  const SITE_CLIENT = window.siteClient || null;
  const OBS = window.siteObservability || null;
  const widgetContainer = document.getElementById('turnstile-widget');
  const statusEl = document.getElementById('turnstile-status');
  const resultEl = document.getElementById('turnstile-result');
  const scenarioLabel = document.getElementById('turnstile-scenario-label');
  const buttons = Array.from(document.querySelectorAll('[data-turnstile-scenario]'));
  let widgetId = null;
  let currentScenario = null;
  let siteKeys = { pass: null, fail: null };

  if (!widgetContainer || !statusEl || !resultEl || !scenarioLabel || !buttons.length) return;

  function setStatus(message, state) {
    statusEl.textContent = message;
    if (state) statusEl.dataset.state = state;
    else delete statusEl.dataset.state;
  }

  function setResult(value) {
    resultEl.hidden = false;
    resultEl.textContent = JSON.stringify(value, null, 2);
  }

  function clearResult() {
    resultEl.hidden = true;
    resultEl.textContent = '';
  }

  function setButtonsDisabled(disabled) {
    buttons.forEach(function (button) {
      button.disabled = disabled;
      button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
  }

  function removeWidget() {
    if (widgetId !== null && window.turnstile && typeof window.turnstile.remove === 'function') {
      window.turnstile.remove(widgetId);
    }
    widgetId = null;
    widgetContainer.innerHTML = '';
  }

  async function verifyToken(token, scenario) {
    const requestJson = SITE_CLIENT && typeof SITE_CLIENT.requestJson === 'function'
      ? SITE_CLIENT.requestJson
      : null;

    if (!requestJson) {
      setStatus('siteClient.requestJson is unavailable on this page.', 'error');
      return;
    }

    setStatus('Verifying token with backend…', 'pending');

    try {
      const data = await requestJson('/api/antibot/turnstile/verify', {
        method: 'POST',
        body: JSON.stringify({ scenario: scenario, token: token }),
      });
      setStatus('Backend verification passed.', 'success');
      setResult(data);
      if (OBS) OBS.logMilestone('turnstile_test_verification_passed', { scenario: scenario });
    } catch (error) {
      const payload = error && error.data ? error.data : {
        message: error && error.message ? error.message : 'Unknown verification error',
      };
      setStatus('Backend verification failed.', 'error');
      setResult(payload);
      if (OBS) {
        OBS.logError({
          eventType: 'turnstile_test_verification_failed',
          message: 'Turnstile test verification failed',
          error: {
            errorName: error && error.name || 'Error',
            stackTrace: error && error.stack || null,
            extra: { scenario: scenario },
          },
        });
      }
    } finally {
      setButtonsDisabled(false);
    }
  }

  function renderWidget(scenario) {
    const siteKey = siteKeys[scenario];
    currentScenario = scenario;
    scenarioLabel.textContent = scenario === 'pass' ? 'Always pass' : 'Always fail';
    clearResult();

    if (!siteKey) {
      setButtonsDisabled(false);
      setStatus('Missing site key for "' + scenario + '" in /api/config.', 'error');
      return;
    }

    if (!window.turnstile || typeof window.turnstile.render !== 'function') {
      setButtonsDisabled(false);
      setStatus('Turnstile script is still loading. Try again in a second.', 'pending');
      return;
    }

    removeWidget();
    setStatus('Widget rendered. Complete the challenge to trigger backend verification.', 'pending');
    widgetId = window.turnstile.render(widgetContainer, {
      sitekey: siteKey,
      theme: document.body.classList.contains('theme-light') ? 'light' : 'dark',
      callback: function (token) {
        verifyToken(token, scenario);
      },
      'error-callback': function (code) {
        setButtonsDisabled(false);
        setStatus('Turnstile widget errored: ' + code, 'error');
        setResult({ error: 'TURNSTILE_WIDGET_ERROR', code: code, scenario: scenario });
      },
      'expired-callback': function () {
        setButtonsDisabled(false);
        setStatus('Turnstile token expired. Render the scenario again.', 'error');
        setResult({ error: 'TURNSTILE_WIDGET_EXPIRED', scenario: scenario });
      },
    });
  }

  async function loadConfig() {
    if (typeof getPublicConfig !== 'function') {
      setStatus('getPublicConfig is unavailable on this page.', 'error');
      return;
    }

    try {
      const data = await getPublicConfig();
      const antibot = data && data.antibot ? data.antibot : {};
      const turnstile = antibot.turnstile || {};
      const testSiteKeys = turnstile.test_site_keys || {};
      siteKeys = {
        pass: typeof testSiteKeys.pass === 'string' && testSiteKeys.pass ? testSiteKeys.pass : null,
        fail: typeof testSiteKeys.fail === 'string' && testSiteKeys.fail ? testSiteKeys.fail : null,
      };

      if (antibot.mode !== 'turnstile') {
        setStatus('ANTIBOT_MODE is "' + antibot.mode + '". Switch it to "turnstile" before testing backend validation.', 'error');
        setResult({ antibot: antibot });
        return;
      }

      if (!siteKeys.pass || !siteKeys.fail) {
        setStatus('Turnstile test site keys are missing from /api/config.', 'error');
        setResult({ antibot: antibot });
        return;
      }

      setStatus('Config loaded. Choose pass or fail to render the widget.', null);
    } catch (error) {
      setStatus('Could not load /api/config.', 'error');
      setResult(error && error.data ? error.data : { message: error && error.message ? error.message : 'Unknown error' });
    }
  }

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      const scenario = button.getAttribute('data-turnstile-scenario');
      if (scenario !== 'pass' && scenario !== 'fail') return;
      setButtonsDisabled(true);
      renderWidget(scenario);
    });
  });

  loadConfig();
})();

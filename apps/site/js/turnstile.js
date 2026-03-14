(function initSiteTurnstile() {
  'use strict';

  const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const TURNSTILE_CONTAINER_ID = 'site-turnstile-root';
  const DEFAULT_PLACEHOLDER_TOKEN = 'placeholder';

  let scriptLoadPromise = null;
  let activeWidgetId = null;

  function getPlaceholderToken(config) {
    return (config && config.turnstilePlaceholderToken) || DEFAULT_PLACEHOLDER_TOKEN;
  }

  function setTurnstileConfigFromPublicConfig(config, publicConfig) {
    const target = config || {};
    const antibot = publicConfig && publicConfig.antibot ? publicConfig.antibot : null;
    const turnstile = antibot && antibot.turnstile ? antibot.turnstile : null;

    target.antibotMode = antibot && typeof antibot.mode === 'string' ? antibot.mode : (target.antibotMode || 'mock');
    target.turnstileEnabled = !!(turnstile && turnstile.enabled === true);
    target.turnstileSiteKey =
      turnstile && typeof turnstile.site_key === 'string' && turnstile.site_key.trim()
        ? turnstile.site_key.trim()
        : null;
    target.turnstileLoadError = null;

    return target;
  }

  function markTurnstileConfigLoadFailed(config, reason) {
    const target = config || {};
    target.turnstileLoadError = typeof reason === 'string' && reason ? reason : 'turnstile_config_load_failed';
    return target;
  }

  function getContainer() {
    let container = document.getElementById(TURNSTILE_CONTAINER_ID);
    if (container) return container;

    container = document.createElement('div');
    container.id = TURNSTILE_CONTAINER_ID;
    container.setAttribute('aria-hidden', 'true');
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.bottom = '0';
    container.style.width = '1px';
    container.style.height = '1px';
    container.style.overflow = 'hidden';
    document.body.appendChild(container);
    return container;
  }

  function cleanupWidget() {
    const container = document.getElementById(TURNSTILE_CONTAINER_ID);
    if (activeWidgetId !== null && window.turnstile && typeof window.turnstile.remove === 'function') {
      try {
        window.turnstile.remove(activeWidgetId);
      } catch (_) {}
    }
    activeWidgetId = null;
    if (container) container.innerHTML = '';
  }

  function loadTurnstileScript() {
    if (window.turnstile && typeof window.turnstile.render === 'function') {
      return Promise.resolve(window.turnstile);
    }

    if (scriptLoadPromise) return scriptLoadPromise;

    scriptLoadPromise = new Promise(function (resolve, reject) {
      const existing = document.querySelector('script[data-site-turnstile-script="true"]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(window.turnstile); }, { once: true });
        existing.addEventListener('error', function () { reject(new Error('Turnstile script failed to load')); }, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.dataset.siteTurnstileScript = 'true';
      script.addEventListener('load', function () { resolve(window.turnstile); }, { once: true });
      script.addEventListener('error', function () { reject(new Error('Turnstile script failed to load')); }, { once: true });
      document.head.appendChild(script);
    });

    return scriptLoadPromise;
  }

  function makeTurnstileError(message, code) {
    const error = new Error(message);
    if (code) error.code = code;
    return error;
  }

  async function resolveTurnstileToken(options) {
    const opts = options || {};
    const config = opts.config || {};
    const observability = opts.observability || null;
    const action = typeof opts.action === 'string' && opts.action ? opts.action : 'submit';
    const formName = typeof opts.formName === 'string' && opts.formName ? opts.formName : 'form';
    const turnstileEnabled = config.turnstileEnabled === true;
    const siteKey = typeof config.turnstileSiteKey === 'string' && config.turnstileSiteKey.trim()
      ? config.turnstileSiteKey.trim()
      : null;

    if (observability && observability.logMilestone) {
      observability.logMilestone('turnstile_gate_evaluated', {
        form: formName,
        action: action,
        antibot_mode: config.antibotMode || null,
        turnstile_enabled: turnstileEnabled,
        site_key_present: !!siteKey,
        branch_taken: turnstileEnabled ? 'execute_turnstile_submit_gate' : 'bypass_turnstile_submit_gate',
      });
    }

    if (!turnstileEnabled) {
      return getPlaceholderToken(config);
    }

    if (config.turnstileLoadError) {
      throw makeTurnstileError('Anti-bot verification is unavailable right now. Please try again.', 'TURNSTILE_CONFIG_UNAVAILABLE');
    }

    if (!siteKey) {
      throw makeTurnstileError('Anti-bot verification is not configured for this page.', 'TURNSTILE_SITE_KEY_MISSING');
    }

    await loadTurnstileScript();
    cleanupWidget();

    return await new Promise(function (resolve, reject) {
      let settled = false;
      const container = getContainer();

      function finishWithError(error) {
        if (settled) return;
        settled = true;
        cleanupWidget();
        reject(error);
      }

      function finishWithToken(token) {
        if (settled) return;
        settled = true;
        cleanupWidget();
        resolve(token);
      }

      try {
        activeWidgetId = window.turnstile.render(container, {
          sitekey: siteKey,
          action: action,
          appearance: 'execute',
          execution: 'execute',
          callback: function (token) {
            finishWithToken(token);
          },
          'error-callback': function (code) {
            finishWithError(makeTurnstileError('Turnstile widget error: ' + code, code || 'TURNSTILE_WIDGET_ERROR'));
          },
          'expired-callback': function () {
            finishWithError(makeTurnstileError('Turnstile token expired. Please try again.', 'TURNSTILE_TOKEN_EXPIRED'));
          },
          'timeout-callback': function () {
            finishWithError(makeTurnstileError('Turnstile verification timed out. Please try again.', 'TURNSTILE_TIMEOUT'));
          },
        });

        if (typeof window.turnstile.execute === 'function') {
          window.turnstile.execute(activeWidgetId);
        } else {
          finishWithError(makeTurnstileError('Turnstile execution API is unavailable.', 'TURNSTILE_EXECUTION_UNAVAILABLE'));
        }
      } catch (error) {
        finishWithError(error instanceof Error ? error : makeTurnstileError('Turnstile execution failed.', 'TURNSTILE_EXECUTION_FAILED'));
      }
    });
  }

  window.SiteTurnstile = {
    applyPublicConfig: setTurnstileConfigFromPublicConfig,
    markConfigLoadFailed: markTurnstileConfigLoadFailed,
    resolveToken: resolveTurnstileToken,
    _cleanupForTests: cleanupWidget,
  };
})();

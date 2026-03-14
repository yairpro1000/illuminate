(function initSiteTurnstile() {
  'use strict';

  const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const DEFAULT_PLACEHOLDER_TOKEN = 'placeholder';
  const widgetStates = new Map();
  let scriptLoadPromise = null;

  function getPlaceholderToken(config) {
    return (config && config.turnstilePlaceholderToken) || DEFAULT_PLACEHOLDER_TOKEN;
  }

  function isEnabled(config) {
    return !!(config && config.turnstileEnabled === true);
  }

  function getSiteKey(config) {
    const directKey = typeof config?.turnstileSiteKey === 'string' && config.turnstileSiteKey.trim()
      ? config.turnstileSiteKey.trim()
      : null;
    if (directKey) return directKey;
    return typeof config?.site_key === 'string' && config.site_key.trim()
      ? config.site_key.trim()
      : null;
  }

  function setTurnstileConfigFromPublicConfig(config, publicConfig) {
    const target = config || {};
    const antibot = publicConfig && publicConfig.antibot ? publicConfig.antibot : null;
    const turnstile = antibot && antibot.turnstile ? antibot.turnstile : null;

    target.antibotMode = antibot && typeof antibot.mode === 'string' ? antibot.mode : (target.antibotMode || 'mock');
    target.turnstileEnabled = !!(turnstile && turnstile.enabled === true);
    target.turnstileSiteKey = getSiteKey(turnstile);
    target.turnstileLoadError = null;

    return target;
  }

  function markTurnstileConfigLoadFailed(config, reason) {
    const target = config || {};
    target.turnstileLoadError = typeof reason === 'string' && reason ? reason : 'turnstile_config_load_failed';
    return target;
  }

  function makeTurnstileError(message, code) {
    const error = new Error(message);
    if (code) error.code = code;
    return error;
  }

  function cleanupWidget(key) {
    const current = widgetStates.get(key);
    if (!current) return;
    if (current.widgetId != null && window.turnstile && typeof window.turnstile.remove === 'function') {
      try {
        window.turnstile.remove(current.widgetId);
      } catch (_) {}
    }
    if (current.container) current.container.innerHTML = '';
    widgetStates.delete(key);
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

  async function renderVisibleWidget(options) {
    const opts = options || {};
    const key = typeof opts.key === 'string' && opts.key ? opts.key : null;
    const config = opts.config || {};
    const container = opts.container || null;
    const onToken = typeof opts.onToken === 'function' ? opts.onToken : function () {};
    const onError = typeof opts.onError === 'function' ? opts.onError : function () {};

    if (!key || !container) return;

    if (!isEnabled(config)) {
      cleanupWidget(key);
      return;
    }

    if (config.turnstileLoadError) {
      onError(makeTurnstileError('Anti-bot verification is unavailable right now. Please try again.', 'TURNSTILE_CONFIG_UNAVAILABLE'));
      return;
    }

    const siteKey = getSiteKey(config);
    if (!siteKey) {
      onError(makeTurnstileError('Anti-bot verification is not configured for this page.', 'TURNSTILE_SITE_KEY_MISSING'));
      return;
    }

    const existing = widgetStates.get(key);
    if (existing && existing.container === container && existing.widgetId != null) {
      return;
    }

    await loadTurnstileScript();
    cleanupWidget(key);
    container.innerHTML = '';

    const state = {
      container,
      widgetId: null,
      token: null,
      action: typeof opts.action === 'string' && opts.action ? opts.action : 'submit',
      siteKey,
    };
    widgetStates.set(key, state);

    try {
      state.widgetId = window.turnstile.render(container, {
        sitekey: siteKey,
        action: state.action,
        theme: document.body.classList.contains('theme-light') ? 'light' : 'dark',
        callback: function (token) {
          state.token = token;
          onToken(token);
        },
        'error-callback': function (code) {
          state.token = null;
          onError(makeTurnstileError('Turnstile widget error: ' + code, code || 'TURNSTILE_WIDGET_ERROR'));
        },
        'expired-callback': function () {
          state.token = null;
          onError(makeTurnstileError('Turnstile token expired. Please complete the anti-bot check again.', 'TURNSTILE_TOKEN_EXPIRED'));
        },
        'timeout-callback': function () {
          state.token = null;
          onError(makeTurnstileError('Turnstile verification timed out. Please complete the anti-bot check again.', 'TURNSTILE_TIMEOUT'));
        },
      });
    } catch (error) {
      state.token = null;
      onError(error instanceof Error ? error : makeTurnstileError('Turnstile widget failed to render.', 'TURNSTILE_RENDER_FAILED'));
    }
  }

  async function resolveTurnstileToken(options) {
    const opts = options || {};
    const key = typeof opts.key === 'string' && opts.key ? opts.key : null;
    const config = opts.config || {};
    const observability = opts.observability || null;
    const action = typeof opts.action === 'string' && opts.action ? opts.action : 'submit';
    const formName = typeof opts.formName === 'string' && opts.formName ? opts.formName : 'form';

    if (observability && observability.logMilestone) {
      observability.logMilestone('turnstile_gate_evaluated', {
        form: formName,
        action: action,
        antibot_mode: config.antibotMode || null,
        turnstile_enabled: isEnabled(config),
        site_key_present: !!getSiteKey(config),
        branch_taken: isEnabled(config) ? 'require_visible_turnstile_token' : 'bypass_turnstile_submit_gate',
      });
    }

    if (!isEnabled(config)) {
      return getPlaceholderToken(config);
    }

    if (config.turnstileLoadError) {
      throw makeTurnstileError('Anti-bot verification is unavailable right now. Please try again.', 'TURNSTILE_CONFIG_UNAVAILABLE');
    }

    if (!key) {
      throw makeTurnstileError('Turnstile widget key is missing.', 'TURNSTILE_WIDGET_KEY_MISSING');
    }

    const state = widgetStates.get(key);
    if (state && state.token) {
      return state.token;
    }

    throw makeTurnstileError('Please complete the anti-bot check before submitting.', 'TURNSTILE_REQUIRED');
  }

  function resetVisibleWidget(key) {
    const state = widgetStates.get(key);
    if (!state) return;
    state.token = null;
    if (state.widgetId != null && window.turnstile && typeof window.turnstile.reset === 'function') {
      try {
        window.turnstile.reset(state.widgetId);
        return;
      } catch (_) {}
    }
    cleanupWidget(key);
  }

  window.SiteTurnstile = {
    applyPublicConfig: setTurnstileConfigFromPublicConfig,
    markConfigLoadFailed: markTurnstileConfigLoadFailed,
    renderVisibleWidget: renderVisibleWidget,
    resolveToken: resolveTurnstileToken,
    resetVisibleWidget: resetVisibleWidget,
    _cleanupForTests: cleanupWidget,
  };
})();

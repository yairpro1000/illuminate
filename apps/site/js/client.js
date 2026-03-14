(function () {
  'use strict';

  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  const DEFAULT_CONFIG = {
    timezone: 'Europe/Zurich',
    antibotMode: 'mock',
    turnstileEnabled: false,
    turnstileSiteKey: null,
    turnstileLoadError: null,
    turnstilePlaceholderToken: 'placeholder',
    defaultBookingPolicyLines: [
      'Booking policy',
      'You can reschedule or cancel your booking up to 24 hours before the session.',
      'Within 24 hours of the session, bookings can no longer be changed online and are non-refundable.',
      'If an emergency occurs, please contact me directly.',
    ],
    contactHref: 'contact.html',
    defaultSessionLocation: 'Lugano, Switzerland',
    defaultEventLocation: 'Lugano, Switzerland',
  };

  function getApiBase() {
    if (typeof window.getSiteApiBase === 'function') return window.getSiteApiBase();
    return window.API_BASE || '';
  }

  function makeRequestId() {
    return (crypto.randomUUID && crypto.randomUUID()) || ('rid_' + Date.now().toString(36));
  }

  function getSessionId() {
    const key = 'site_observability_session_id';
    try {
      let value = localStorage.getItem(key);
      if (!value) {
        value = makeRequestId().replace(/^rid_/, 'sid_');
        localStorage.setItem(key, value);
      }
      return value;
    } catch (_) {
      return 'site_session_unavailable';
    }
  }

  const OBS_LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
  const OBS_DEFAULT_MIN_LEVEL = 'warn';

  function normalizeObsLevel(raw) {
    const key = String(raw || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(OBS_LEVEL_RANK, key) ? key : OBS_DEFAULT_MIN_LEVEL;
  }

  function getSiteMinObsLevel() {
    try {
      const fromStorage = localStorage.getItem('site_observability_min_level');
      if (fromStorage && fromStorage.trim()) return normalizeObsLevel(fromStorage);
    } catch (_) {}
    const fromEnv =
      (window.ENV && (window.ENV.VITE_SITE_OBSERVABILITY_MIN_LEVEL || window.ENV.VITE_FRONTEND_OBSERVABILITY_MIN_LEVEL)) ||
      undefined;
    return normalizeObsLevel(fromEnv);
  }

  function shouldSendObsLevel(level) {
    return OBS_LEVEL_RANK[normalizeObsLevel(level)] >= OBS_LEVEL_RANK[getSiteMinObsLevel()];
  }

  function truncatePreview(value, max) {
    const text = String(value == null ? '' : value);
    const limit = typeof max === 'number' ? max : 1200;
    return text.length <= limit ? text : text.slice(0, limit) + '…';
  }

  function getObservabilityEndpoint() {
    return getApiBase() + '/api/observability/frontend';
  }

  function createSiteObservability() {
    const sessionId = getSessionId();
    let currentFlowId = makeRequestId().replace(/^rid_/, 'cid_');

    function emit(level, payload) {
      const requestId = payload.requestId || makeRequestId();
      const event = {
        level,
        eventType: payload.eventType || 'frontend_event',
        message: payload.message || null,
        errorCode: payload.errorCode || null,
        requestId,
        correlationId: payload.correlationId || currentFlowId,
        sessionId,
        route: payload.route || window.location.pathname,
        context: Object.assign({ user_agent: navigator.userAgent }, payload.context || {}),
        api: payload.api || undefined,
        apiFailure: payload.apiFailure || undefined,
        error: payload.error || undefined,
      };

      if (shouldSendObsLevel(level)) {
        const payloadText = JSON.stringify(event);
        try {
          if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            const queued = navigator.sendBeacon(
              getObservabilityEndpoint(),
              new Blob([payloadText], { type: 'text/plain;charset=UTF-8' }),
            );
            if (!queued) {
              fetch(getObservabilityEndpoint(), {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                body: payloadText,
                keepalive: true,
              }).catch(function () {});
            }
          } else {
            fetch(getObservabilityEndpoint(), {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
              body: payloadText,
              keepalive: true,
            }).catch(function () {});
          }
        } catch (_) {}
      }

      const line = JSON.stringify(event);
      if (shouldSendObsLevel(level)) {
        if (level === 'error' || level === 'fatal') console.error('[site-observability]', line);
        else if (level === 'warn') console.warn('[site-observability]', line);
        else console.log('[site-observability]', line);
      }
      return requestId;
    }

    return {
      sessionId: sessionId,
      getCorrelationId: function () { return currentFlowId; },
      startFlow: function (name) {
        currentFlowId = makeRequestId().replace(/^rid_/, 'cid_');
        emit('info', {
          eventType: 'flow_milestone',
          correlationId: currentFlowId,
          message: name || 'flow_started',
          context: { milestone: name || 'flow_started' },
        });
        return currentFlowId;
      },
      logInfo: function (payload) { return emit('info', payload || {}); },
      logWarn: function (payload) { return emit('warn', payload || {}); },
      logError: function (payload) { return emit('error', payload || {}); },
      logMilestone: function (name, context) {
        return emit('info', {
          eventType: 'flow_milestone',
          message: name,
          context: Object.assign({ milestone: name }, context || {}),
        });
      },
    };
  }

  if (!window.siteObservability) {
    window.siteObservability = createSiteObservability();
    window.addEventListener('error', function (event) {
      window.siteObservability.logError({
        eventType: 'uncaught_exception',
        message: event.message || 'Unhandled window error',
        error: {
          errorName: event.error && event.error.name || 'Error',
          stackTrace: event.error && event.error.stack || null,
          file: event.filename || null,
          lineNumber: event.lineno || null,
          columnNumber: event.colno || null,
          extra: { source: 'window.onerror' },
        },
      });
    });
    window.addEventListener('unhandledrejection', function (event) {
      const reason = event.reason;
      window.siteObservability.logError({
        eventType: 'uncaught_exception',
        message: 'Unhandled promise rejection',
        error: {
          errorName: reason && reason.name || 'UnhandledRejection',
          stackTrace: reason && reason.stack || null,
          extra: { reason: truncatePreview(reason && reason.message || reason) },
        },
      });
    });
    window.siteObservability.logMilestone('page_loaded', { title: document.title });
  }

  function getCorrelationId(method, path) {
    const obs = window.siteObservability || null;
    if (!obs) return makeRequestId();
    if (method === 'GET' && typeof obs.getCorrelationId === 'function') {
      return obs.getCorrelationId();
    }
    if (typeof obs.startFlow === 'function') {
      return obs.startFlow('site_' + method.toLowerCase() + '_' + String(path || '').replace(/[^a-z0-9]+/gi, '_'));
    }
    return makeRequestId();
  }

  async function parseJsonishResponse(res) {
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) return await res.json();

    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(text); } catch (_) {}
    }
    return { message: text.slice(0, 300) };
  }

  async function requestJson(path, init) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const apiBase = getApiBase();
    const url = /^https?:\/\//i.test(path) ? path : (apiBase + path);
    const requestId = makeRequestId();
    const correlationId = getCorrelationId(method, path);
    const headers = new Headers((init && init.headers) || undefined);
    if (init && init.body != null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    headers.set('x-request-id', requestId);
    headers.set('x-correlation-id', correlationId);

    const _sp = window.siteSpinner;
    if (_sp) _sp.show();
    try {
      const res = await fetch(url, {
        credentials: 'same-origin',
        ...(init || {}),
        method,
        headers,
      });
      const data = await parseJsonishResponse(res);
      if (!res.ok) {
        const message = typeof data?.message === 'string' ? data.message : ('HTTP ' + res.status);
        if (window.siteObservability) {
          window.siteObservability.logError({
            eventType: 'request_failure',
            message: method + ' ' + path,
            requestId: requestId,
            correlationId: correlationId,
            api: {
              direction: 'outbound',
              provider: 'site_api',
              method: method,
              url: url,
              path: path,
              statusCode: res.status,
              success: false,
            },
            apiFailure: {
              responseBody: truncatePreview(typeof data?.message === 'string' ? data.message : JSON.stringify(data || {}), 300),
            },
          });
        }
        const error = new Error(message);
        error.status = res.status;
        error.data = data;
        throw error;
      }
      return data;
    } finally {
      if (_sp) _sp.hide();
    }
  }

  window.siteClient = {
    getApiBase: getApiBase,
    makeRequestId: makeRequestId,
    parseJsonishResponse: parseJsonishResponse,
    requestJson: requestJson,
    config: DEFAULT_CONFIG,
  };

  // ── Global loading spinner (used by requestJson here and in api.js) ──────
  if (!window.siteSpinner) {
    (function () {
      var n = 0;
      var el = null;
      function getOverlayEl() {
        if (el) return el;
        var style = document.createElement('style');
        style.textContent =
          '@keyframes site-spin{to{transform:rotate(360deg)}}' +
          '.site-spinner-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
          'justify-content:center;background:rgba(0,0,0,0.35);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}' +
          '.site-spinner-ring{width:52px;height:52px;border-radius:50%;' +
          'border:4px solid var(--color-lake-mist,rgba(255,255,255,0.12));' +
          'border-top-color:var(--color-lake,#7aa2ff);animation:site-spin 0.7s linear infinite}';
        document.head.appendChild(style);
        el = document.createElement('div');
        el.className = 'site-spinner-overlay';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<div class="site-spinner-ring"></div>';
        return el;
      }
      window.siteSpinner = {
        show: function () { if (++n === 1) document.body.appendChild(getOverlayEl()); },
        hide: function () { if (--n <= 0) { n = 0; if (el && el.parentNode) el.parentNode.removeChild(el); } },
      };
    }());
  }
})();

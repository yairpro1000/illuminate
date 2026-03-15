(function () {
  'use strict';

  function makeId(prefix) {
    return (crypto.randomUUID && crypto.randomUUID()) || (prefix + '_' + Date.now().toString(36));
  }

  function getSessionId() {
    const key = 'admin_observability_session_id';
    try {
      let value = localStorage.getItem(key);
      if (!value) {
        value = makeId('sid');
        localStorage.setItem(key, value);
      }
      return value;
    } catch (_) {
      return 'admin_session_unavailable';
    }
  }

  function createAdminObservability() {
    const sessionId = getSessionId();
    let correlationId = makeId('cid');

    function send(level, payload) {
      const event = {
        level: level,
        eventType: payload.eventType || 'frontend_event',
        message: payload.message || null,
        requestId: payload.requestId || makeId('rid'),
        correlationId: payload.correlationId || correlationId,
        sessionId: sessionId,
        route: window.location.pathname,
        context: Object.assign({ app_area: 'admin', user_agent: navigator.userAgent }, payload.context || {}),
        api: payload.api || undefined,
        apiFailure: payload.apiFailure || undefined,
      };
      try {
        fetch(resolveUrl('/observability/frontend'), {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'x-request-id': event.requestId,
            'x-correlation-id': event.correlationId,
          },
          credentials: 'include',
          keepalive: true,
          body: JSON.stringify(event),
        }).catch(function () {});
      } catch (_) {}
      return event.requestId;
    }

    return {
      getCorrelationId: function () { return correlationId; },
      startFlow: function (name) {
        correlationId = makeId('cid');
        send('info', { eventType: 'flow_milestone', message: name || 'flow_started', correlationId: correlationId });
        return correlationId;
      },
      logError: function (payload) { return send('error', payload || {}); },
      logInfo: function (payload) { return send('info', payload || {}); },
      logMilestone: function (name, context) {
        return send('info', { eventType: 'flow_milestone', message: name, context: context || {} });
      },
    };
  }

  function resolveUrl(path) {
    return window.resolveAdminUrl(path);
  }

  function buildRequestInit(init) {
    const next = {
      method: 'GET',
      credentials: 'include',
      ...(init || {}),
    };
    const headers = new Headers((init && init.headers) || undefined);
    if (next.body != null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'text/plain;charset=UTF-8');
    }
    next.headers = headers;
    return next;
  }

  function detectUiTestMode() {
    try {
      if (window.__ILLUMINATE_UI_TEST_MODE__) return String(window.__ILLUMINATE_UI_TEST_MODE__).trim().toLowerCase() || null;
    } catch (_) {}
    try {
      var params = new URLSearchParams(window.location.search || '');
      var fromQuery = String(params.get('ui_test_mode') || '').trim().toLowerCase();
      if (fromQuery) return fromQuery;
    } catch (_) {}
    try {
      var fromStorage = String(localStorage.getItem('illuminate_ui_test_mode') || '').trim().toLowerCase();
      if (fromStorage) return fromStorage;
    } catch (_) {}
    if (typeof navigator !== 'undefined' && navigator.webdriver) return 'playwright';
    return null;
  }

  function ensureMockEmailPreviewRendererLoaded() {
    if (window.IlluminateMockEmailPreview && typeof window.IlluminateMockEmailPreview.render === 'function') {
      return Promise.resolve(window.IlluminateMockEmailPreview);
    }
    if (window.__illuminateMockEmailPreviewLoadPromise) return window.__illuminateMockEmailPreviewLoadPromise;

    window.__illuminateMockEmailPreviewLoadPromise = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-illuminate-mock-email-preview="true"]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(window.IlluminateMockEmailPreview || null); }, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }

      var script = document.createElement('script');
      script.src = 'js/mock-email-preview.js';
      script.async = true;
      script.dataset.illuminateMockEmailPreview = 'true';
      script.addEventListener('load', function () { resolve(window.IlluminateMockEmailPreview || null); }, { once: true });
      script.addEventListener('error', reject, { once: true });
      document.head.appendChild(script);
    });
    return window.__illuminateMockEmailPreviewLoadPromise;
  }

  async function maybeRenderMockEmailPreview(body) {
    var preview = body && body.mock_email_preview;
    var uiTestMode = detectUiTestMode();
    if (!uiTestMode || !preview) return;
    try {
      var renderer = await ensureMockEmailPreviewRendererLoaded();
      if (renderer && typeof renderer.render === 'function') renderer.render({ preview: preview });
    } catch (_) {}
  }

  async function requestJson(path, init) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const obs = window.adminObservability || null;
    const requestId = makeId('rid');
    const correlationId = obs && typeof obs.getCorrelationId === 'function'
      ? (method === 'GET' ? obs.getCorrelationId() : obs.startFlow('admin_' + method.toLowerCase() + '_' + String(path || '').replace(/[^a-z0-9]+/gi, '_')))
      : makeId('cid');
    const next = buildRequestInit(init);
    const headers = new Headers(next.headers || undefined);
    headers.set('x-request-id', requestId);
    headers.set('x-correlation-id', correlationId);
    const uiTestMode = detectUiTestMode();
    if (uiTestMode) headers.set('x-illuminate-ui-test-mode', uiTestMode);
    next.headers = headers;

    const res = await fetch(resolveUrl(path), next);
    if (res.status === 401 && window.adminAuth) {
      try { window.adminAuth.handleUnauthorized(401); } catch (_) {}
    }
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      body = { raw: text };
    }
    if (!res.ok) {
      if (obs) {
        obs.logError({
          eventType: 'request_failure',
          message: method + ' ' + path,
          requestId: requestId,
          correlationId: correlationId,
          api: {
            direction: 'outbound',
            provider: 'admin_api',
            method: method,
            url: resolveUrl(path),
            path: path,
            statusCode: res.status,
            success: false,
          },
          apiFailure: {
            responseBody: JSON.stringify(body),
          },
        });
      }
      const error = new Error(res.status + ' ' + res.statusText + ': ' + JSON.stringify(body));
      error.status = res.status;
      error.data = body;
      throw error;
    }
    if (obs) {
      obs.logInfo({
        eventType: 'request',
        message: method + ' ' + path,
        requestId: requestId,
        correlationId: correlationId,
        api: {
          direction: 'outbound',
          provider: 'admin_api',
          method: method,
          url: resolveUrl(path),
          path: path,
          statusCode: res.status,
          success: true,
        },
      });
    }
    await maybeRenderMockEmailPreview(body);
    return body;
  }

  window.adminObservability = window.adminObservability || createAdminObservability();
  window.adminClient = {
    resolveUrl: resolveUrl,
    buildRequestInit: buildRequestInit,
    requestJson: requestJson,
    detectUiTestMode: detectUiTestMode,
    maybeRenderMockEmailPreview: maybeRenderMockEmailPreview,
  };
})();

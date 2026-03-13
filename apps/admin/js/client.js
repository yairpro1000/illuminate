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
    return body;
  }

  window.adminObservability = window.adminObservability || createAdminObservability();
  window.adminClient = {
    resolveUrl: resolveUrl,
    buildRequestInit: buildRequestInit,
    requestJson: requestJson,
  };
})();

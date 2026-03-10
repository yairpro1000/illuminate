(function(){
  'use strict';
  var STORAGE_KEY = 'admin_api_base';
  var LOCAL_HOSTS = { 'localhost':1, '127.0.0.1':1, '::1':1 };

  function sanitizeBase(s) { return String(s || '').replace(/\/+$/g, ''); }

  function computeRootBase() {
    try {
      var fromStorage = localStorage.getItem(STORAGE_KEY);
      if (fromStorage && fromStorage.trim()) return sanitizeBase(fromStorage);
    } catch (_) {}

    var envBase = (window.ENV && window.ENV.VITE_API_BASE) || '';
    if (String(envBase).trim()) return sanitizeBase(envBase);
    if (LOCAL_HOSTS[location.hostname]) return 'http://localhost:8788';
    return 'https://api.letsilluminate.co';
  }

  function computeAdminApiBase() {
    // Back-compat: if localStorage/admin_api_base is set, it is assumed to be
    // the full base (e.g. '/api' or 'https://api.host/api'). Otherwise build
    // from root API base + '/api'.
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && stored.trim()) return sanitizeBase(stored);
    } catch (_) {}
    return sanitizeBase(computeRootBase()) + '/api';
  }

  function setApiBaseFromQuery() {
    try {
      var params = new URLSearchParams(window.location.search);
      var fromQuery = (params.get('apiBase') || '').trim();
      if (fromQuery) localStorage.setItem(STORAGE_KEY, sanitizeBase(fromQuery));
    } catch (_) {}
  }

  function resolveAdminUrl(path) {
    var base = computeAdminApiBase();
    if (/^https?:\/\//i.test(path)) return path;
    return base + (path.startsWith('/') ? path : ('/' + path));
  }

  // Expose helpers
  window.getAdminApiBase = computeAdminApiBase;
  window.resolveAdminUrl = resolveAdminUrl;
  window.__setAdminApiBaseFromQuery = setApiBaseFromQuery;

  // Initialize override from query if present
  setApiBaseFromQuery();
})();

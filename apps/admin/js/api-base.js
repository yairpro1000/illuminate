(function(){
  'use strict';
  var STORAGE_KEY = 'admin_api_base';
  var LOCAL_HOSTS = { 'localhost':1, '127.0.0.1':1, '::1':1 };

  function sanitizeBase(s) { return String(s || '').replace(/\/+$/g, ''); }

  function getHostname() {
    try {
      if (window.__ADMIN_API_BASE_HOSTNAME__) return String(window.__ADMIN_API_BASE_HOSTNAME__).toLowerCase();
    } catch (_) {}
    return String(location.hostname || '').toLowerCase();
  }

  function getSearch() {
    try {
      if (typeof window.__ADMIN_API_BASE_SEARCH__ === 'string') return window.__ADMIN_API_BASE_SEARCH__;
    } catch (_) {}
    return String(location.search || '');
  }

  function isLocalhost() {
    return !!LOCAL_HOSTS[getHostname()];
  }

  function getStoredBase() {
    if (!isLocalhost()) return '';
    try {
      var fromStorage = localStorage.getItem(STORAGE_KEY);
      return fromStorage && fromStorage.trim() ? sanitizeBase(fromStorage) : '';
    } catch (_) {
      return '';
    }
  }

  function computeRootBase() {
    var fromStorage = getStoredBase();
    if (fromStorage) return fromStorage;

    var envBase = (window.ENV && window.ENV.VITE_API_BASE) || '';
    if (String(envBase).trim()) return sanitizeBase(envBase);
    if (isLocalhost()) return 'http://localhost:8788';
    return 'https://api.letsilluminate.co';
  }

  function computeAdminApiBase() {
    // Back-compat: if localStorage/admin_api_base is set, it is assumed to be
    // the full base (e.g. '/api' or 'https://api.host/api'). Otherwise build
    // from root API base + '/api'.
    var stored = getStoredBase();
    if (stored) return stored;
    return sanitizeBase(computeRootBase()) + '/api';
  }

  function setApiBaseFromQuery() {
    try {
      var params = new URLSearchParams(getSearch());
      var fromQuery = (params.get('apiBase') || '').trim();
      if (!fromQuery) return;
      if (!isLocalhost()) {
        // Prevent stale production breakage from old/debug query overrides.
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
        return;
      }
      localStorage.setItem(STORAGE_KEY, sanitizeBase(fromQuery));
    } catch (_) {}
  }

  function clearProdOverride() {
    if (isLocalhost()) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
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

  // Never persist admin API base overrides on production domains.
  clearProdOverride();
  // Initialize override from query if present
  setApiBaseFromQuery();
})();

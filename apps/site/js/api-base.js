(function(){
  'use strict';
  var LOCAL_HOSTS = { 'localhost':1, '127.0.0.1':1, '::1':1 };
  var WORKER_ROOT_HOSTS = { 'yairb.ch':1, 'www.yairb.ch':1 };
  var PAGES_DEV_SUFFIX = '.pages.dev';
  var PREVIEW_WORKER_ROOT = 'https://illuminate.yairpro.workers.dev';
  function sanitizeBase(s) { return String(s || '').replace(/\/+$/g, ''); }
  function getHostname() {
    try {
      if (window.__SITE_API_BASE_HOSTNAME__) return String(window.__SITE_API_BASE_HOSTNAME__).toLowerCase();
    } catch (_) {}
    return String(location.hostname || '').toLowerCase();
  }
  function computeSiteApiBase() {
    try {
      var fromStorage = localStorage.getItem('API_BASE');
      if (fromStorage && fromStorage.trim()) return sanitizeBase(fromStorage);
    } catch (_) {}
    var envBase = (window.ENV && window.ENV.VITE_API_BASE) || '';
    if (String(envBase).trim()) return sanitizeBase(envBase);
    if (LOCAL_HOSTS[getHostname()]) return 'http://localhost:8788';
    if (WORKER_ROOT_HOSTS[getHostname()]) return PREVIEW_WORKER_ROOT;
    if (getHostname().endsWith(PAGES_DEV_SUFFIX)) return PREVIEW_WORKER_ROOT;
    return 'https://api.letsilluminate.co';
  }
  var base = computeSiteApiBase();
  window.getSiteApiBase = function(){ return base; };
  window.API_BASE = base;
})();

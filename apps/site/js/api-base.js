(function(){
  'use strict';
  var LOCAL_HOSTS = { 'localhost':1, '127.0.0.1':1, '::1':1 };
  function sanitizeBase(s) { return String(s || '').replace(/\/+$/g, ''); }
  function computeSiteApiBase() {
    try {
      var fromStorage = localStorage.getItem('API_BASE');
      if (fromStorage && fromStorage.trim()) return sanitizeBase(fromStorage);
    } catch (_) {}
    var envBase = (window.ENV && window.ENV.VITE_API_BASE) || '';
    if (String(envBase).trim()) return sanitizeBase(envBase);
    if (LOCAL_HOSTS[location.hostname]) return 'http://localhost:8788';
    return 'https://api.letsilluminate.co';
  }
  var base = computeSiteApiBase();
  window.getSiteApiBase = function(){ return base; };
  window.API_BASE = base;
})();

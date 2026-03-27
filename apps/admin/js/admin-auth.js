(function(){
  'use strict';

  function getEnvValue(key) {
    try {
      return String((window.ENV && window.ENV[key]) || '').trim();
    } catch (_) {}
    return '';
  }

  function getCurrentReturnPath() {
    try {
      var path = String(location.pathname || '/');
      var search = String(location.search || '');
      var hash = String(location.hash || '');
      return path + search + hash;
    } catch (_) {}
    return '/';
  }

  function getRootApiBase() {
    try {
      // Prefer the same root base used by api-base.js
      if (typeof window.getAdminApiBase === 'function') {
        var full = String(window.getAdminApiBase() || '');
        // getAdminApiBase() typically returns root+'/api'
        var m = full.match(/^(.*?)(?:\/api)?$/);
        return m ? m[1] : full.replace(/\/$/, '');
      }
    } catch (_) {}
    // Fallback to current origin
    return location.origin;
  }

  function buildAccessLoginUrl() {
    var accessTeamDomain = getEnvValue('VITE_CLOUDFLARE_ACCESS_TEAM_DOMAIN');
    if (accessTeamDomain) {
      var protectedHostname = getEnvValue('VITE_CLOUDFLARE_ACCESS_APP_HOSTNAME') || location.hostname;
      return 'https://' + accessTeamDomain
        + '/cdn-cgi/access/login/' + protectedHostname
        + '?redirect_url=' + encodeURIComponent(getCurrentReturnPath());
    }
    var root = getRootApiBase();
    // Cloudflare Access supports /cdn-cgi/access/login on the application domain
    var returnTo = encodeURIComponent(root + '/api/health');
    return root + '/cdn-cgi/access/login?returnTo=' + returnTo;
  }

  function buildAccessLogoutUrl() {
    var accessTeamDomain = getEnvValue('VITE_CLOUDFLARE_ACCESS_TEAM_DOMAIN');
    var root = accessTeamDomain ? ('https://' + accessTeamDomain) : getRootApiBase();
    var returnTo = encodeURIComponent(buildAccessLoginUrl());
    return root + '/cdn-cgi/access/logout?returnTo=' + returnTo;
  }

  function redirectToReLogin() {
    location.assign(buildAccessLogoutUrl());
  }

  function ensureHeaderLogoutButton() {
    var id = 'admin-logout-button';
    var header = document.querySelector('.admin-header');
    if (!header) return null;

    var existing = document.getElementById(id);
    if (existing) {
      if (!existing.dataset.logoutBound) {
        existing.addEventListener('click', redirectToReLogin);
        existing.dataset.logoutBound = 'true';
      }
      return existing;
    }

    var button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = 'theme-toggle';
    button.textContent = 'Logout';
    button.title = 'Log out of Cloudflare Access and reopen the sign-in options';
    button.addEventListener('click', redirectToReLogin);
    button.dataset.logoutBound = 'true';

    var themeToggle = document.getElementById('themeToggle');
    if (themeToggle && themeToggle.parentNode === header) {
      header.insertBefore(button, themeToggle);
    } else {
      header.appendChild(button);
    }

    return button;
  }

  function ensureBanner() {
    var id = 'admin-signin-banner';
    var el = document.getElementById(id);
    if (el) return el;
    el = document.createElement('div');
    el.id = id;
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.right = '0';
    el.style.bottom = '0';
    el.style.zIndex = '2147483646';
    el.style.background = '#0d9488';
    el.style.color = '#fff';
    el.style.borderTop = '1px solid rgba(0,0,0,0.1)';
    el.style.boxShadow = '0 -6px 18px rgba(0,0,0,0.18)';
    el.style.padding = '12px 14px';
    el.style.display = 'flex';
    el.style.gap = '10px';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'space-between';

    var left = document.createElement('div');
    left.style.fontSize = '0.98rem';
    left.style.fontWeight = '600';
    left.textContent = 'Admin sign-in required';

    var right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '8px';
    right.style.alignItems = 'center';

    var msg = document.createElement('div');
    msg.style.fontSize = '0.9rem';
    msg.style.opacity = '0.95';
    msg.textContent = 'Open the login page, sign in, then return here and refresh.';

    var loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.textContent = 'Sign in to Admin';
    loginBtn.style.background = '#fff';
    loginBtn.style.color = '#0d9488';
    loginBtn.style.border = '1px solid #d1d5db';
    loginBtn.style.borderRadius = '8px';
    loginBtn.style.padding = '8px 12px';
    loginBtn.style.cursor = 'pointer';
    loginBtn.addEventListener('click', function(){
      var url = buildAccessLoginUrl();
      window.open(url, '_blank', 'noopener');
    });

    var refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.background = 'rgba(255,255,255,0.15)';
    refreshBtn.style.color = '#fff';
    refreshBtn.style.border = '1px solid rgba(255,255,255,0.35)';
    refreshBtn.style.borderRadius = '8px';
    refreshBtn.style.padding = '8px 12px';
    refreshBtn.style.cursor = 'pointer';
    refreshBtn.addEventListener('click', function(){ location.reload(); });

    right.appendChild(msg);
    right.appendChild(loginBtn);
    right.appendChild(refreshBtn);

    el.appendChild(left);
    el.appendChild(right);
    document.body.appendChild(el);
    return el;
  }

  function showSignIn() {
    ensureBanner();
  }

  function handleUnauthorized(status) {
    if (status === 401) showSignIn();
  }

  window.adminAuth = {
    getRootApiBase: getRootApiBase,
    buildAccessLoginUrl: buildAccessLoginUrl,
    buildAccessLogoutUrl: buildAccessLogoutUrl,
    redirectToReLogin: redirectToReLogin,
    ensureHeaderLogoutButton: ensureHeaderLogoutButton,
    showSignIn: showSignIn,
    handleUnauthorized: handleUnauthorized,
  };

  ensureHeaderLogoutButton();
})();

(function () {
  'use strict';

  var page = (location.pathname.split('/').pop() || 'index.html');
  if (page === '' || page === '/') page = 'index.html';
  var map = {
    'index.html': 'index',
    'session-types.html': 'session-types',
    'contact-messages.html': 'contact-messages',
    'config.html': 'config',
  };
  var key = map[page] || 'index';
  var el = document.querySelector('.admin-nav-link[data-page="' + key + '"]');
  if (el) el.classList.add('active');
})();

(function () {
  'use strict';

  var segment = location.pathname.split('/').pop().replace(/\.html$/, '') || 'index';
  var el = document.querySelector('.admin-nav-link[data-page="' + segment + '"]');
  if (el) el.classList.add('active');
})();

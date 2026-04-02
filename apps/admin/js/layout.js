(function () {
  'use strict';

  // ── Active nav link ──
  var segment = location.pathname.split('/').pop().replace(/\.html$/, '') || 'index';
  var el = document.querySelector('.admin-nav-link[data-page="' + segment + '"]');
  if (el) el.classList.add('active');

  // ── Mobile sidebar styles ──
  // Inject once so all pages get hamburger + is-open support
  if (!document.getElementById('admin-mobile-styles')) {
    var style = document.createElement('style');
    style.id = 'admin-mobile-styles';
    style.textContent = [
      '@media (max-width: 48rem) {',
      '  .admin-shell { grid-template-columns: 1fr !important; }',
      '  .admin-sidebar { display: none; }',
      '  .admin-sidebar.is-open {',
      '    display: block;',
      '    position: fixed;',
      '    inset: var(--admin-header-h, 3.5rem) 0 0 0;',
      '    z-index: 100;',
      '    overflow-y: auto;',
      '  }',
      '  .admin-hamburger { display: flex !important; }',
      '}',
      '.admin-hamburger {',
      '  display: none;',
      '  align-items: center;',
      '  justify-content: center;',
      '  background: transparent;',
      '  border: 1px solid var(--color-border);',
      '  border-radius: var(--radius-sm, 0.375rem);',
      '  color: var(--color-text-muted);',
      '  padding: 0.25rem 0.5rem;',
      '  font-size: 1.125rem;',
      '  line-height: 1;',
      '  cursor: pointer;',
      '  order: -1;',
      '}',
      '.admin-hamburger:hover { border-color: var(--color-border-hover); color: var(--color-text); }',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ── Hamburger button ──
  function initHamburger() {
    var header = document.querySelector('.admin-header');
    var sidebar = document.querySelector('.admin-sidebar');
    if (!header || !sidebar) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-hamburger';
    btn.setAttribute('aria-label', 'Toggle navigation');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '&#9776;';

    btn.addEventListener('click', function () {
      var open = sidebar.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Close sidebar when clicking a nav link (navigation happens anyway, but good UX)
    sidebar.addEventListener('click', function (e) {
      if (e.target && e.target.classList.contains('admin-nav-link')) {
        sidebar.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });

    // Close when clicking outside on mobile
    document.addEventListener('click', function (e) {
      if (!sidebar.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        sidebar.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });

    // Insert as first child of header
    header.insertBefore(btn, header.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHamburger);
  } else {
    initHamburger();
  }
})();

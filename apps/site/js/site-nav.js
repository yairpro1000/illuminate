const NAV_THEME_TOGGLE_HTML = `
  <button id="theme-toggle" class="theme-toggle" aria-label="Switch to dark mode" title="Toggle theme">
    <span class="theme-toggle__tip" aria-hidden="true"></span>
    <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
    <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  </button>
`;

const NAV_MOBILE_THEME_TOGGLE_HTML = `
  <button id="mobile-theme-toggle" class="nav__mobile-theme" role="menuitem">
    <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
    <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
    <span class="mobile-theme-label">Dark Mode</span>
  </button>
`;

function navLink(label, href, currentPage, key) {
  const currentAttr = currentPage === key ? ' aria-current="page"' : '';
  return `<a href="${href}"${currentAttr}>${label}</a>`;
}

function navItem(label, href, currentPage, key) {
  return `<li>${navLink(label, href, currentPage, key)}</li>`;
}

function getNavItems(variant, homeLinksMode) {
  const homePrefix = homeLinksMode === 'self' ? '' : 'index.html';
  const howHref = `${homePrefix}#how-we-work`;
  const aboutHref = `${homePrefix}#about`;

  if (variant === 'worldview') {
    return [
      { key: 'how', label: 'How We Work', href: howHref },
      { key: 'investment', label: 'Investment', href: `${homePrefix}#investment` },
      { key: 'about', label: 'About', href: aboutHref },
      { key: 'evenings', label: 'Evenings', href: 'evenings.html' },
      { key: 'worldview', label: 'My Worldview', href: 'worldview.html' },
    ];
  }

  return [
    { key: 'how', label: 'How We Work', href: howHref },
    { key: 'about', label: 'About', href: aboutHref },
    { key: 'evenings', label: 'Evenings', href: 'evenings.html' },
    { key: 'contact', label: 'Get in touch', href: 'contact.html' },
  ];
}

function renderNav(nav) {
  const variant = nav.dataset.navVariant || 'default';
  const homeLinksMode = nav.dataset.homeLinks || 'index';
  const currentPage = nav.dataset.currentPage || '';
  const logoHref = nav.dataset.logoHref || 'index.html';
  const ctaHref = nav.dataset.ctaHref || 'sessions.html';
  const ctaLabel = nav.dataset.ctaLabel || 'Book a Session';
  const ctaCurrent = nav.dataset.ctaCurrent === 'page';
  const showInlineThemeToggle = nav.dataset.inlineThemeToggle === 'true';
  const items = getNavItems(variant, homeLinksMode);

  const desktopLinks = items
    .map((item) => navItem(item.label, item.href, currentPage, item.key))
    .join('');
  const mobileLinks = items
    .map((item) => navLink(item.label, item.href, currentPage, item.key).replace('<a ', '<a role="menuitem" '))
    .join('');
  const ctaCurrentAttr = ctaCurrent ? ' aria-current="page"' : '';

  nav.innerHTML = `
    <div class="nav__inner">
      <a href="${logoHref}" class="nav__logo">
        <span class="nav__logo-brand">ILLUMINATE</span> <span>by Yair Benharroch</span>
      </a>
      <ul class="nav__links" role="list">
        ${desktopLinks}
      </ul>
      <a href="${ctaHref}" class="nav__cta"${ctaCurrentAttr}>${ctaLabel}</a>
      ${showInlineThemeToggle ? NAV_THEME_TOGGLE_HTML : ''}
      <button class="nav__hamburger" aria-label="Open menu" aria-expanded="false" aria-controls="mobile-menu">
        <span></span>
        <span></span>
        <span></span>
      </button>
    </div>
    <div id="mobile-menu" class="nav__mobile" role="menu">
      ${NAV_MOBILE_THEME_TOGGLE_HTML}
      ${mobileLinks}
      <a href="${ctaHref}" role="menuitem"${ctaCurrentAttr}>${ctaLabel}</a>
    </div>
  `;
}

function getFooterItems(variant, homeLinksMode) {
  const homePrefix = homeLinksMode === 'self' ? '' : 'index.html';

  if (variant === 'worldview') {
    return [
      { key: 'how', label: 'How We Work', href: `${homePrefix}#how-we-work` },
      { key: 'investment', label: 'Investment', href: `${homePrefix}#investment` },
      { key: 'about', label: 'About', href: `${homePrefix}#about` },
      { key: 'worldview', label: 'My Worldview', href: 'worldview.html' },
      { key: 'contact-mail', label: 'Contact', href: 'mailto:hello@yairbendavid.com' },
    ];
  }

  return [
    { key: 'how', label: 'How We Work', href: `${homePrefix}#how-we-work` },
    { key: 'about', label: 'About', href: `${homePrefix}#about` },
    { key: 'evenings', label: 'Evenings', href: 'evenings.html' },
    { key: 'sessions', label: '1:1 Sessions', href: 'sessions.html' },
    { key: 'contact', label: 'Get in touch', href: 'contact.html' },
  ];
}

function renderFooter(footer) {
  const variant = footer.dataset.footerVariant || 'default';
  const homeLinksMode = footer.dataset.homeLinks || 'index';
  const currentPage = footer.dataset.currentPage || '';
  const items = getFooterItems(variant, homeLinksMode);
  const links = items
    .map((item) => navLink(item.label, item.href, currentPage, item.key))
    .join('');

  footer.innerHTML = `
    <div class="footer__inner">
      <span class="footer__logo">ILLUMINATE <span>by Yair Benharroch</span></span>
      <nav class="footer__links" aria-label="Footer navigation">
        ${links}
      </nav>
      <span class="footer__copy">© 2026 ILLUMINATE · Yair Benharroch</span>
    </div>
  `;
}

document.querySelectorAll('.nav[data-nav-variant]').forEach(renderNav);
document.querySelectorAll('.footer[data-footer-variant]').forEach(renderFooter);

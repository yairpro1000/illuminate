(function initSiteCoupon(global) {
  'use strict';

  const STORAGE_KEY = 'couponCode';
  const CHF_TO_ILS_DISPLAY_RATE = 4;
  const ISRAEL_COUPON = Object.freeze({
    code: 'ISRAEL',
    discountPercent: 25,
  });
  const HOME_SUGGESTION_SECTION_ID = 'how-we-work';
  let homeSuggestionTriggered = false;
  let visitorCountry = null;
  let visitorCountryResolved = false;
  let visitorCountryRequest = null;

  function roundAmount(amount) {
    return Math.round(Number(amount || 0) * 100) / 100;
  }

  function normalizeCouponCode(raw) {
    if (typeof raw !== 'string') return null;
    const normalized = raw.trim().toUpperCase();
    return normalized || null;
  }

  function getSupportedCoupon(rawCode) {
    const normalized = normalizeCouponCode(rawCode);
    return normalized === ISRAEL_COUPON.code ? ISRAEL_COUPON : null;
  }

  function getAppliedCoupon() {
    try {
      return getSupportedCoupon(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return null;
    }
  }

  function emitCouponChange(source) {
    const coupon = getAppliedCoupon();
    window.dispatchEvent(new CustomEvent('sitecouponchange', {
      detail: {
        source: source || 'unknown',
        couponCode: coupon ? coupon.code : null,
      },
    }));
  }

  function setAppliedCouponCode(rawCode, source) {
    const coupon = getSupportedCoupon(rawCode);
    if (!coupon) return false;
    try {
      localStorage.setItem(STORAGE_KEY, coupon.code);
    } catch (_) {
      return false;
    }
    renderAppliedIndicator();
    emitCouponChange(source || 'apply');
    return true;
  }

  function clearAppliedCouponCode(source) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    renderAppliedIndicator();
    emitCouponChange(source || 'remove');
  }

  function normalizeCountryCode(raw) {
    if (typeof raw !== 'string') return null;
    const normalized = raw.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
  }

  function getHeuristicIsraelVisitor() {
    let timeZone = '';
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (_) {}
    const languages = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language || ''];
    const hasHebrewLanguage = languages.some((language) => /^he\b/i.test(String(language || '').trim()));
    const hasIsraelLocale = languages.some((language) => /-IL\b/i.test(String(language || '').trim()));
    return timeZone === 'Asia/Jerusalem' || hasHebrewLanguage || hasIsraelLocale;
  }

  function isLikelyIsraelVisitor() {
    if (!visitorCountryResolved) return false;
    if (visitorCountry) return visitorCountry === 'IL';
    return getHeuristicIsraelVisitor();
  }

  function emitVisitorContextRefresh(source) {
    window.dispatchEvent(new CustomEvent('sitecouponchange', {
      detail: {
        source: source || 'visitor_context_refresh',
        couponCode: getAppliedCouponCode() || null,
      },
    }));
  }

  function resolveVisitorCountry() {
    if (visitorCountryResolved) return Promise.resolve(visitorCountry);
    if (visitorCountryRequest) return visitorCountryRequest;
    visitorCountryRequest = window.fetch('/api/config', {
      headers: {
        Accept: 'application/json',
      },
      credentials: 'same-origin',
    })
      .then((response) => {
        if (!response || !response.ok) throw new Error(`config_fetch_failed:${response ? response.status : 'unknown'}`);
        return response.json();
      })
      .then((payload) => {
        visitorCountry = normalizeCountryCode(payload && payload.visitor ? payload.visitor.country : null);
        visitorCountryResolved = true;
      })
      .catch(() => {
        visitorCountry = null;
        visitorCountryResolved = true;
      })
      .finally(() => {
        visitorCountryRequest = null;
        emitVisitorContextRefresh('visitor_country_resolved');
      });
    return visitorCountryRequest;
  }

  function formatNumber(amount) {
    const rounded = roundAmount(amount);
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(rounded);
  }

  function formatChf(amount, currency) {
    return `${String(currency || 'CHF').toUpperCase()} ${formatNumber(amount)}`;
  }

  function formatIls(amount) {
    return `${formatNumber(roundAmount(amount) * CHF_TO_ILS_DISPLAY_RATE)} ₪`;
  }

  function getDisplayedPrice(basePrice, couponCode) {
    const roundedBasePrice = roundAmount(basePrice);
    const coupon = getSupportedCoupon(couponCode || getAppliedCouponCode());
    if (!Number.isFinite(roundedBasePrice) || roundedBasePrice <= 0 || !coupon) {
      return {
        active: false,
        couponCode: null,
        discountPercent: 0,
        baseChf: roundedBasePrice,
        finalChf: roundedBasePrice,
        baseIls: roundAmount(roundedBasePrice * CHF_TO_ILS_DISPLAY_RATE),
        finalIls: roundAmount(roundedBasePrice * CHF_TO_ILS_DISPLAY_RATE),
      };
    }

    const finalChf = roundAmount(roundedBasePrice * (1 - coupon.discountPercent / 100));
    return {
      active: true,
      couponCode: coupon.code,
      discountPercent: coupon.discountPercent,
      baseChf: roundedBasePrice,
      finalChf,
      baseIls: roundAmount(roundedBasePrice * CHF_TO_ILS_DISPLAY_RATE),
      finalIls: roundAmount(finalChf * CHF_TO_ILS_DISPLAY_RATE),
    };
  }

  function getPricePreview(basePrice, couponCode) {
    return getDisplayedPrice(basePrice, couponCode);
  }

  function buildPriceHtml(basePrice, currency, options) {
    const preview = getDisplayedPrice(basePrice, options && options.couponCode);
    const suffix = options && options.suffix ? ` <span class="coupon-price__suffix">${options.suffix}</span>` : '';
    if (!Number.isFinite(basePrice) || Number(basePrice) <= 0) {
      return '<span class="coupon-price coupon-price--free">Free</span>';
    }
    if (!preview.active) {
      return `<span class="coupon-price coupon-price--standard">${formatChf(preview.baseChf, currency)}${suffix}</span>`;
    }
    return `
      <span class="coupon-price coupon-price--discounted">
        <span class="coupon-price__old"><s>${formatChf(preview.baseChf, currency)} (${formatIls(preview.baseChf)})${suffix}</s></span>
        <strong class="coupon-price__new">${formatChf(preview.finalChf, currency)} (${formatIls(preview.finalChf)})${suffix}</strong>
      </span>
    `;
  }

  function getAppliedCouponCode() {
    const coupon = getAppliedCoupon();
    return coupon ? coupon.code : '';
  }

  function buildSuggestionBannerHtml() {
    if (!isLikelyIsraelVisitor() || getAppliedCoupon()) return '';
    return `
      <div class="coupon-banner" data-coupon-suggestion>
        <div class="coupon-banner__content">
          <p class="coupon-banner__eyebrow">Israel pricing</p>
          <p class="coupon-banner__text">🇮🇱 נראה שאתם גולשים מישראל. ייתכן שמגיע לכם מחיר מקומי.</p>
        </div>
        <button class="btn btn-secondary coupon-banner__action" type="button" data-coupon-apply="${ISRAEL_COUPON.code}">
          Apply Israel discount
        </button>
      </div>
    `;
  }

  function renderAppliedIndicator() {
    let indicator = document.querySelector('[data-coupon-indicator]');
    const coupon = getAppliedCoupon();
    if (!coupon) {
      if (indicator) indicator.remove();
      return;
    }

    if (!indicator) {
      indicator = document.createElement('div');
      indicator.setAttribute('data-coupon-indicator', 'true');
      indicator.className = 'coupon-indicator';
      document.body.appendChild(indicator);
    }

    if (indicator.parentElement !== document.body) {
      document.body.appendChild(indicator);
    }

    indicator.style.position = 'fixed';
    indicator.style.right = 'max(1rem, env(safe-area-inset-right, 0px))';
    indicator.style.bottom = 'max(1rem, env(safe-area-inset-bottom, 0px))';
    indicator.style.left = 'auto';
    indicator.style.top = 'auto';

    indicator.innerHTML = `
      <span class="coupon-indicator__label">🇮🇱 Israel discount applied</span>
      <button type="button" class="coupon-indicator__remove" data-coupon-remove="true" aria-label="Remove Israel discount">✕</button>
    `;
  }

  function syncCouponOffset() {
    const nav = document.querySelector('.nav');
    const navHeight = nav ? Math.ceil(nav.getBoundingClientRect().height) : 72;
    document.documentElement.style.setProperty('--coupon-banner-offset', `${navHeight}px`);
  }

  function applyStaticPrices(root) {
    (root || document).querySelectorAll('[data-coupon-price]').forEach((node) => {
      const basePrice = Number(node.getAttribute('data-price-chf') || 0);
      const currency = node.getAttribute('data-price-currency') || 'CHF';
      const suffix = node.getAttribute('data-price-suffix') || '';
      node.innerHTML = buildPriceHtml(basePrice, currency, { suffix: suffix || null });
    });
  }

  function mountSuggestionInto(container) {
    if (!container || container.querySelector('[data-coupon-suggestion]') || getAppliedCoupon() || !isLikelyIsraelVisitor()) return;
    container.insertAdjacentHTML('afterbegin', buildSuggestionBannerHtml());
  }

  function removeSuggestionBanners() {
    document.querySelectorAll('[data-coupon-suggestion]').forEach((node) => node.remove());
  }

  function refreshPageSuggestions() {
    removeSuggestionBanners();
    if (getAppliedCoupon() || !isLikelyIsraelVisitor()) return;

    const page = document.body.getAttribute('data-page');
    if (page === 'home' && homeSuggestionTriggered) {
      const section = document.getElementById(HOME_SUGGESTION_SECTION_ID);
      mountSuggestionInto(section && (section.querySelector('.container') || section));
      const investment = document.getElementById('investment');
      mountSuggestionInto(investment && (investment.querySelector('.container') || investment));
      return;
    }
    if (page === 'sessions') {
      mountSuggestionInto(document.querySelector('#session-types .container'));
    }
  }

  function initHomeSuggestion() {
    const section = document.getElementById(HOME_SUGGESTION_SECTION_ID);
    if (!section || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        homeSuggestionTriggered = true;
        refreshPageSuggestions();
        observer.disconnect();
      });
    }, { threshold: 0.35 });
    observer.observe(section);
  }

  function initPageSuggestions() {
    const page = document.body.getAttribute('data-page');
    if (page === 'home') initHomeSuggestion();
    if (page === 'sessions') {
      mountSuggestionInto(document.querySelector('#session-types .container'));
    }
  }

  document.addEventListener('click', (event) => {
    const applyButton = event.target.closest('[data-coupon-apply]');
    if (applyButton) {
      const code = applyButton.getAttribute('data-coupon-apply');
      if (setAppliedCouponCode(code, 'banner_apply')) {
        applyStaticPrices(document);
      }
      return;
    }

    const removeButton = event.target.closest('[data-coupon-remove]');
    if (removeButton) {
      const shouldRemove = window.confirm('Remove Israel discount and return to standard pricing?');
      if (!shouldRemove) return;
      clearAppliedCouponCode('indicator_remove');
      applyStaticPrices(document);
    }
  });

  window.addEventListener('sitecouponchange', () => {
    syncCouponOffset();
    renderAppliedIndicator();
    applyStaticPrices(document);
    refreshPageSuggestions();
  });

  document.addEventListener('DOMContentLoaded', () => {
    syncCouponOffset();
    renderAppliedIndicator();
    applyStaticPrices(document);
    initPageSuggestions();
    resolveVisitorCountry();
  });

  window.addEventListener('resize', syncCouponOffset);
  window.addEventListener('scroll', syncCouponOffset, { passive: true });

  global.SiteCoupon = {
    CHF_TO_ILS_DISPLAY_RATE,
    normalizeCouponCode,
    getAppliedCouponCode,
    getSupportedCoupon,
    getDisplayedPrice,
    getPricePreview,
    buildPriceHtml,
    buildSuggestionBannerHtml,
    isLikelyIsraelVisitor,
    resolveVisitorCountry,
    setAppliedCouponCode,
    clearAppliedCouponCode,
    applyStaticPrices,
  };
})(window);

/* ============================================================
   ILLUMINATE — Add to Calendar widget
   Builds Google / Apple / Outlook / .ics options from data attributes.
   Public API:
     buildAtcWidget(opts)  → HTML string to inject
     initAddToCalendar(root?)  → wire up widgets inside root (or document)
   ============================================================ */

'use strict';

/* ── Date helpers ────────────────────────────────────────── */

const DEFAULT_ATC_TIMEZONE = 'Europe/Zurich';

function _toWallClockParts(isoStr, timeZone) {
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = {};
  for (const p of parts) map[p.type] = p.value;
  if (!map.year || !map.month || !map.day || !map.hour || !map.minute || !map.second) return null;

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

/**
 * Converts an ISO string into local wall-clock format for the chosen timezone.
 * Falls back to the first 19 chars for malformed inputs.
 */
function _calStr(isoStr, timeZone) {
  const wall = _toWallClockParts(isoStr, timeZone);
  if (wall) {
    return `${wall.year}${wall.month}${wall.day}T${wall.hour}${wall.minute}${wall.second}`;
  }
  return String(isoStr || '').slice(0, 19).replace(/[-:]/g, '');
}

function _localIsoNoOffset(isoStr, timeZone) {
  const wall = _toWallClockParts(isoStr, timeZone);
  if (wall) {
    return `${wall.year}-${wall.month}-${wall.day}T${wall.hour}:${wall.minute}:${wall.second}`;
  }
  return String(isoStr || '').slice(0, 19);
}

/* ── URL / blob builders ─────────────────────────────────── */

function _googleUrl(d) {
  const timeZone = d.timezone || DEFAULT_ATC_TIMEZONE;
  const p = new URLSearchParams({
    action:   'TEMPLATE',
    text:     d.title,
    dates:    _calStr(d.start, timeZone) + '/' + _calStr(d.end, timeZone),
    ctz:      timeZone,
    details:  d.description || '',
    location: d.location    || '',
  });
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

function _outlookUrl(d) {
  const timeZone = d.timezone || DEFAULT_ATC_TIMEZONE;
  const p = new URLSearchParams({
    path:     '/calendar/action/compose',
    rru:      'addevent',
    subject:  d.title,
    startdt:  _localIsoNoOffset(d.start, timeZone),
    enddt:    _localIsoNoOffset(d.end, timeZone),
    body:     d.description || '',
    location: d.location    || '',
  });
  return 'https://outlook.live.com/calendar/0/deeplink/compose?' + p.toString();
}

function _makeIcsBlob(d) {
  const timeZone = d.timezone || DEFAULT_ATC_TIMEZONE;
  const uid  = 'illuminate-' + Date.now() + Math.random().toString(36).slice(2) + '@yairbendavid.com';
  const now  = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const esc  = s => (s || '').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ILLUMINATE by Yair Benharroch//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:'          + uid,
    'DTSTAMP:'      + now,
    'DTSTART;TZID=' + timeZone + ':' + _calStr(d.start, timeZone),
    'DTEND;TZID=' + timeZone + ':' + _calStr(d.end, timeZone),
    'SUMMARY:'      + esc(d.title),
    'DESCRIPTION:'  + esc(d.description || ''),
    'LOCATION:'     + esc(d.location    || ''),
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  return new Blob([text], { type: 'text/calendar;charset=utf-8' });
}

function _downloadIcs(d) {
  const url  = URL.createObjectURL(_makeIcsBlob(d));
  const slug = d.title.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase();
  const a    = Object.assign(document.createElement('a'), { href: url, download: slug + '.ics' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Widget HTML ─────────────────────────────────────────── */

/**
 * Returns an HTML string for the widget.
 * @param {{ title, start, end, location?, description?, timezone? }} opts
 *   start / end must be ISO 8601 strings with local datetime
 */
function buildAtcWidget(opts) {
  const e = s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `
    <div class="atc-widget"
         data-atc-title="${e(opts.title)}"
         data-atc-start="${e(opts.start)}"
         data-atc-end="${e(opts.end)}"
         data-atc-location="${e(opts.location || '')}"
         data-atc-desc="${e(opts.description || '')}"
         data-atc-timezone="${e(opts.timezone || DEFAULT_ATC_TIMEZONE)}">
      <button class="atc-trigger" type="button"
              aria-haspopup="true" aria-expanded="false">
        <svg class="atc-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.25" y="2.5" width="13.5" height="12.25" rx="2"
                stroke="currentColor" stroke-width="1.2"/>
          <path d="M1.25 6.75h13.5M5 1.5v2.5M11 1.5v2.5"
                stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        Add to calendar
      </button>
      <div class="atc-dropdown" hidden role="menu">

        <a class="atc-option" role="menuitem"
           data-atc-google href="#" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.1"/>
            <path d="M1.5 6.5h13M6.5 1.5v13" stroke="currentColor" stroke-width="1.1"/>
          </svg>
          Google Calendar
        </a>

        <button class="atc-option" role="menuitem" type="button" data-atc-apple>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.1"/>
            <path d="M1.5 6.5h13M6.5 1.5v13" stroke="currentColor" stroke-width="1.1"/>
            <circle cx="10.5" cy="4" r=".75" fill="currentColor"/>
          </svg>
          Apple Calendar
        </button>

        <a class="atc-option" role="menuitem"
           data-atc-outlook href="#" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1" y="3" width="9" height="10" rx="1.5" stroke="currentColor" stroke-width="1.1"/>
            <path d="M10 6.5l5-2.5v8l-5-2.5" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
            <circle cx="5.5" cy="8" r="2" stroke="currentColor" stroke-width="1"/>
          </svg>
          Outlook
        </a>

        <div class="atc-divider" role="separator"></div>

        <button class="atc-option" role="menuitem" type="button" data-atc-ics>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2v9M5 8l3 3 3-3M2.5 14h11"
                  stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Download .ics
        </button>

      </div>
    </div>
  `;
}

/* ── Init ────────────────────────────────────────────────── */

/**
 * Wire up all uninitialised .atc-widget elements inside root (defaults to document).
 * Safe to call multiple times — already-initialised widgets are skipped.
 */
function initAddToCalendar(root) {
  const scope = root || document;

  scope.querySelectorAll('.atc-widget:not([data-atc-ready])').forEach(widget => {
    widget.setAttribute('data-atc-ready', '1');

    const trigger  = widget.querySelector('.atc-trigger');
    const dropdown = widget.querySelector('.atc-dropdown');
    if (!trigger || !dropdown) return;

    const d = {
      title:       widget.dataset.atcTitle    || '',
      start:       widget.dataset.atcStart    || '',
      end:         widget.dataset.atcEnd      || '',
      location:    widget.dataset.atcLocation || '',
      description: widget.dataset.atcDesc     || '',
      timezone:    widget.dataset.atcTimezone || DEFAULT_ATC_TIMEZONE,
    };

    // Pre-build external URLs
    const googleLink  = dropdown.querySelector('[data-atc-google]');
    const outlookLink = dropdown.querySelector('[data-atc-outlook]');
    if (googleLink)  googleLink.href  = _googleUrl(d);
    if (outlookLink) outlookLink.href = _outlookUrl(d);

    // .ics downloads
    dropdown.querySelectorAll('[data-atc-apple], [data-atc-ics]').forEach(btn => {
      btn.addEventListener('click', () => { _downloadIcs(d); closeDropdown(); });
    });

    // The nearest card-like ancestor that might create a stacking context
    const stackingParent = widget.closest('.event-card, .booking-card');

    // Toggle helpers
    function openDropdown() {
      // Close any other open dropdowns first
      document.querySelectorAll('.atc-dropdown:not([hidden])').forEach(other => {
        if (other !== dropdown) {
          other.hidden = true;
          other.closest('.atc-widget')
               ?.querySelector('.atc-trigger')
               ?.setAttribute('aria-expanded', 'false');
          other.closest('.event-card, .booking-card')?.style.removeProperty('z-index');
        }
      });
      dropdown.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      if (stackingParent) stackingParent.style.zIndex = '10';
    }

    function closeDropdown() {
      dropdown.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (stackingParent) stackingParent.style.removeProperty('z-index');
    }

    trigger.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.hidden ? openDropdown() : closeDropdown();
    });

    document.addEventListener('click', e => {
      if (!widget.contains(e.target)) closeDropdown();
    });

    widget.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeDropdown(); trigger.focus(); }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => initAddToCalendar());

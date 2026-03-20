(function () {
  'use strict';

  const R2_BASE = 'https://images.letsilluminate.co';
  const DRIVE_BASE = 'https://drive.google.com/file/d';
  const SESSION_TYPE_STATUSES = ['draft', 'active', 'hidden'];
  const AVAILABILITY_MODES = ['shared_default', 'dedicated'];
  const WEEKDAY_OPTIONS = [
    { value: '1', label: 'Mon' },
    { value: '2', label: 'Tue' },
    { value: '3', label: 'Wed' },
    { value: '4', label: 'Thu' },
    { value: '5', label: 'Fri' },
    { value: '6', label: 'Sat' },
    { value: '7', label: 'Sun' },
  ];
  const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'sold_out'];

  const state = {
    tab: 'session-types',
    stRows: [], stSearch: '', stEditing: null, stSaving: false, stUploading: false, stLoadingDetail: false,
    evRows: [], evSearch: '', evEditing: null, evSaving: false, evUploading: false,
  };

  function msg(el, text, isErr) {
    el.className = isErr ? 'status err' : 'status muted';
    el.textContent = text || '';
  }

  function api(path, init) {
    return window.adminClient.requestJson(path, init);
  }

  function cell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function normalizePriceValue(price) {
    const amount = Number(price);
    if (!Number.isFinite(amount)) return 0;
    return Math.round(amount * 100) / 100;
  }

  function formatPriceNumber(price) {
    const amount = normalizePriceValue(price);
    return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  }

  function formatPrice(price, currency) {
    const amount = normalizePriceValue(price);
    const code = String(currency || 'CHF').toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch (_) {
      return `${formatPriceNumber(amount)} ${code}`;
    }
  }

  function isoToLocal(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function setStatusOptions(selectEl, options) {
    selectEl.innerHTML = '';
    for (const value of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      selectEl.appendChild(option);
    }
  }

  function pickAllowedStatus(rawValue, allowed, fallback) {
    return allowed.includes(rawValue) ? rawValue : fallback;
  }

  function parseTextareaList(value) {
    return String(value || '')
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function joinTextareaList(items) {
    return Array.isArray(items) ? items.join('\n') : '';
  }

  function normalizeAvailabilityState(source) {
    const input = source && typeof source === 'object' ? source : {};
    const windows = Array.isArray(input.windows) ? input.windows : [];
    const upcomingWeeks = Array.isArray(input.upcoming_weeks) ? input.upcoming_weeks : [];
    return {
      mode: AVAILABILITY_MODES.includes(input.mode) ? input.mode : 'shared_default',
      timezone: input.timezone || input.availability_timezone || 'Europe/Zurich',
      weekly_booking_limit: input.weekly_booking_limit == null || input.weekly_booking_limit === '' ? null : Number(input.weekly_booking_limit),
      slot_step_minutes: input.slot_step_minutes == null || input.slot_step_minutes === '' ? null : Number(input.slot_step_minutes),
      windows: windows.map((row, index) => ({
        weekday_iso: Number(row.weekday_iso) || 1,
        start_local_time: String(row.start_local_time || '09:00:00').slice(0, 5),
        end_local_time: String(row.end_local_time || '10:00:00').slice(0, 5),
        sort_order: Number.isInteger(Number(row.sort_order)) ? Number(row.sort_order) : index,
        active: row.active !== false,
      })),
      upcoming_weeks: upcomingWeeks,
    };
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const stView = document.getElementById('stView');
  const evView = document.getElementById('evView');
  const newBtn = document.getElementById('newBtn');
  const statusEl = document.getElementById('status');
  const searchInput = document.getElementById('searchInput');

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.tab = btn.dataset.tab;
      searchInput.value = '';
      state.stSearch = '';
      state.evSearch = '';
      if (state.tab === 'session-types') {
        stView.classList.remove('hidden');
        evView.classList.add('hidden');
        renderST();
      } else {
        evView.classList.remove('hidden');
        stView.classList.add('hidden');
        renderEV();
        if (!state.evRows.length) void loadEvents();
      }
    });
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (state.tab === 'session-types') {
      state.stSearch = q;
      renderST();
    } else {
      state.evSearch = q;
      renderEV();
    }
  });

  newBtn.addEventListener('click', () => {
    if (state.tab === 'session-types') void openST(null);
    else openEV(null);
  });

  const stBody = document.getElementById('stBody');
  const stOverlay = document.getElementById('stOverlay');
  const stEditMsg = document.getElementById('stEditMsg');
  const stFTitle = document.getElementById('stFTitle');
  const stFSlug = document.getElementById('stFSlug');
  const stFShort = document.getElementById('stFShort');
  const stFDesc = document.getElementById('stFDesc');
  const stFDuration = document.getElementById('stFDuration');
  const stFPrice = document.getElementById('stFPrice');
  const stFCurrency = document.getElementById('stFCurrency');
  const stFStatus = document.getElementById('stFStatus');
  const stFSort = document.getElementById('stFSort');
  const stFImage = document.getElementById('stFImage');
  const stFAlt = document.getElementById('stFAlt');
  const stFImageKey = document.getElementById('stFImageKey');
  const stFDriveId = document.getElementById('stFDriveId');
  const stImgMsg = document.getElementById('stImgMsg');
  const stImgPreview = document.getElementById('stImgPreview');
  const stFAvailabilityMode = document.getElementById('stFAvailabilityMode');
  const stFAvailabilityTimezone = document.getElementById('stFAvailabilityTimezone');
  const stFWeeklyLimit = document.getElementById('stFWeeklyLimit');
  const stFSlotStep = document.getElementById('stFSlotStep');
  const stWindowsBody = document.getElementById('stWindowsBody');
  const stOverridesWrap = document.getElementById('stOverridesWrap');
  const stOverridesBody = document.getElementById('stOverridesBody');
  const stSaveBtn = document.getElementById('stSave');

  setStatusOptions(stFStatus, SESSION_TYPE_STATUSES);
  setStatusOptions(stFAvailabilityMode, AVAILABILITY_MODES);

  function ensureAvailability() {
    if (!state.stEditing.availability) {
      state.stEditing.availability = normalizeAvailabilityState({});
    }
    return state.stEditing.availability;
  }

  function renderAvailabilityWindows() {
    const availability = ensureAvailability();
    stWindowsBody.innerHTML = '';
    if (!availability.windows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5" class="muted">No windows configured.</td>';
      stWindowsBody.appendChild(tr);
      return;
    }

    availability.windows.forEach((windowRow, index) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <select data-window-field="weekday_iso" data-window-index="${index}">
            ${WEEKDAY_OPTIONS.map((option) => `<option value="${option.value}"${String(windowRow.weekday_iso) === option.value ? ' selected' : ''}>${option.label}</option>`).join('')}
          </select>
        </td>
        <td><input data-window-field="start_local_time" data-window-index="${index}" type="time" value="${escapeHtml(String(windowRow.start_local_time || '').slice(0, 5))}" /></td>
        <td><input data-window-field="end_local_time" data-window-index="${index}" type="time" value="${escapeHtml(String(windowRow.end_local_time || '').slice(0, 5))}" /></td>
        <td><input data-window-field="active" data-window-index="${index}" type="checkbox"${windowRow.active ? ' checked' : ''} /></td>
        <td><button type="button" class="secondary" data-remove-window="${index}">Remove</button></td>
      `;
      stWindowsBody.appendChild(tr);
    });
  }

  function weekStatusPill(week) {
    const label = week.mode === 'FORCE_CLOSED'
      ? 'Closed'
      : week.mode === 'FORCE_OPEN'
        ? 'Force open'
        : (week.effective_weekly_booking_limit == null ? 'Auto' : `Auto · limit ${week.effective_weekly_booking_limit}`);
    return `<span class="pill">${escapeHtml(label)}</span>`;
  }

  function formatWeekCapacity(week) {
    if (week.effective_weekly_booking_limit == null) {
      return `${week.active_booking_count} / unbounded`;
    }
    return `${week.active_booking_count} / ${week.effective_weekly_booking_limit}`;
  }

  function renderAvailabilityOverrides() {
    const availability = ensureAvailability();
    stOverridesBody.innerHTML = '';
    if (!state.stEditing.id) {
      stOverridesBody.innerHTML = '<tr><td colspan="4" class="muted">Save the session type first to manage week overrides.</td></tr>';
      return;
    }
    if (!availability.upcoming_weeks.length) {
      stOverridesBody.innerHTML = '<tr><td colspan="4" class="muted">No upcoming weeks loaded.</td></tr>';
      return;
    }
    availability.upcoming_weeks.forEach((week) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(week.week_start_date)}</td>
        <td>${weekStatusPill(week)}</td>
        <td>${escapeHtml(formatWeekCapacity(week))}</td>
        <td>
          <div class="row">
            <button type="button" class="secondary" data-override-week="${escapeHtml(week.week_start_date)}" data-override-mode="FORCE_CLOSED">Close</button>
            <button type="button" class="secondary" data-override-week="${escapeHtml(week.week_start_date)}" data-override-mode="FORCE_OPEN">Open</button>
            <button type="button" class="secondary" data-override-week="${escapeHtml(week.week_start_date)}" data-override-mode="AUTO">Auto</button>
            <button type="button" class="secondary" data-override-limit="${escapeHtml(week.week_start_date)}">Custom limit</button>
          </div>
        </td>
      `;
      stOverridesBody.appendChild(tr);
    });
  }

  function renderST() {
    stBody.innerHTML = '';
    let rows = state.stRows;
    if (state.stSearch) {
      rows = rows.filter((r) => (r.title + ' ' + (r.short_description || '') + ' ' + r.status).toLowerCase().includes(state.stSearch));
    }
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'muted';
      td.textContent = 'No rows.';
      tr.appendChild(td);
      stBody.appendChild(tr);
      return;
    }
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.appendChild(cell(r.title));
      tr.appendChild(cell(formatPrice(r.price, r.currency)));
      tr.appendChild(cell(`${r.duration_minutes} min`));
      tr.appendChild(cell(r.status));
      tr.appendChild(cell(String(r.sort_order || 0)));
      tr.addEventListener('click', () => { void openST(r); });
      stBody.appendChild(tr);
    }
  }

  async function loadST() {
    msg(statusEl, 'Loading...');
    try {
      const data = await api('/admin/session-types');
      state.stRows = data.session_types || [];
      renderST();
      msg(statusEl, 'Ready.');
    } catch (e) {
      msg(statusEl, String(e), true);
    }
  }

  function hydrateSessionTypeEditor(detail, fallbackRow) {
    const sessionType = detail && detail.session_type ? detail.session_type : fallbackRow;
    const availabilitySource = detail && detail.availability ? detail.availability : fallbackRow;
    state.stEditing = sessionType ? {
      ...sessionType,
      availability: normalizeAvailabilityState(availabilitySource),
    } : {
      title: '', slug: '', short_description: '', description: '', duration_minutes: 60, price: 0, currency: 'CHF',
      status: SESSION_TYPE_STATUSES[0], sort_order: 0, image_key: null, image_alt: null, drive_file_id: null,
      availability_mode: 'shared_default', availability_timezone: 'Europe/Zurich', weekly_booking_limit: null, slot_step_minutes: null,
      availability: normalizeAvailabilityState({ timezone: 'Europe/Zurich' }),
    };
  }

  function syncSessionTypeEditorFields() {
    stFTitle.value = state.stEditing.title || '';
    stFSlug.value = state.stEditing.slug || '';
    stFShort.value = state.stEditing.short_description || '';
    stFDesc.value = state.stEditing.description || '';
    stFDuration.value = state.stEditing.duration_minutes || 60;
    stFPrice.value = formatPriceNumber(state.stEditing.price || 0);
    stFCurrency.value = state.stEditing.currency || 'CHF';
    stFStatus.value = pickAllowedStatus(state.stEditing.status, SESSION_TYPE_STATUSES, SESSION_TYPE_STATUSES[0]);
    stFSort.value = state.stEditing.sort_order || 0;
    stFAlt.value = state.stEditing.image_alt || '';
    stFImageKey.value = state.stEditing.image_key || '';
    stFDriveId.value = state.stEditing.drive_file_id || '';
    const availability = ensureAvailability();
    stFAvailabilityMode.value = availability.mode;
    stFAvailabilityTimezone.value = availability.timezone || 'Europe/Zurich';
    stFWeeklyLimit.value = availability.weekly_booking_limit == null ? '' : String(availability.weekly_booking_limit);
    stFSlotStep.value = availability.slot_step_minutes == null ? '' : String(availability.slot_step_minutes);
    if (state.stEditing.url) {
      stImgPreview.src = state.stEditing.url;
      stImgPreview.classList.remove('hidden');
    } else if (state.stEditing.image_key) {
      stImgPreview.src = `${R2_BASE}/${state.stEditing.image_key}`;
      stImgPreview.classList.remove('hidden');
    } else {
      stImgPreview.classList.add('hidden');
    }
    stFImage.value = '';
    renderAvailabilityWindows();
    renderAvailabilityOverrides();
  }

  async function openST(row) {
    hydrateSessionTypeEditor(null, row);
    syncSessionTypeEditorFields();
    msg(stEditMsg, '');
    msg(stImgMsg, '');
    stOverlay.classList.remove('hidden');
    stOverlay.setAttribute('aria-hidden', 'false');
    if (row && row.id) {
      state.stLoadingDetail = true;
      msg(stEditMsg, 'Loading availability…');
      try {
        const detail = await api(`/admin/session-types/${encodeURIComponent(row.id)}`);
        hydrateSessionTypeEditor(detail, row);
        syncSessionTypeEditorFields();
        msg(stEditMsg, '');
      } catch (e) {
        msg(stEditMsg, String(e), true);
      } finally {
        state.stLoadingDetail = false;
      }
    }
  }

  function closeST() {
    stOverlay.classList.add('hidden');
    stOverlay.setAttribute('aria-hidden', 'true');
  }

  async function saveST() {
    if (state.stSaving || state.stLoadingDetail) return;
    state.stSaving = true;
    stSaveBtn.disabled = true;
    msg(stEditMsg, 'Saving...');
    try {
      const availability = ensureAvailability();
      state.stEditing.image_key = stFImageKey.value.trim() || null;
      state.stEditing.drive_file_id = stFDriveId.value.trim() || null;
      const priceRaw = String(stFPrice.value ?? '').trim();
      const price = priceRaw === '' ? 0 : Number(priceRaw);
      if (!Number.isFinite(price) || price < 0) {
        throw new Error('Price must be a non-negative number.');
      }
      const weeklyLimitRaw = String(stFWeeklyLimit.value || '').trim();
      const slotStepRaw = String(stFSlotStep.value || '').trim();
      const weeklyLimit = weeklyLimitRaw ? Number(weeklyLimitRaw) : null;
      const slotStep = slotStepRaw ? Number(slotStepRaw) : null;
      if (weeklyLimit != null && (!Number.isInteger(weeklyLimit) || weeklyLimit <= 0)) {
        throw new Error('Weekly limit must be a positive integer.');
      }
      if (slotStep != null && (!Number.isInteger(slotStep) || slotStep <= 0)) {
        throw new Error('Slot step must be a positive integer.');
      }
      const payload = {
        title: stFTitle.value.trim(),
        slug: stFSlug.value.trim(),
        short_description: stFShort.value.trim() || null,
        description: stFDesc.value,
        duration_minutes: Number(stFDuration.value) || 0,
        price: normalizePriceValue(price),
        currency: stFCurrency.value.trim() || 'CHF',
        status: stFStatus.value,
        sort_order: Number(stFSort.value) || 0,
        image_key: state.stEditing.image_key,
        image_alt: stFAlt.value.trim() || null,
        drive_file_id: state.stEditing.drive_file_id,
        availability: {
          mode: stFAvailabilityMode.value,
          timezone: stFAvailabilityTimezone.value.trim() || 'Europe/Zurich',
          weekly_booking_limit: weeklyLimit,
          slot_step_minutes: slotStep,
          windows: availability.windows.map((window, index) => ({
            weekday_iso: Number(window.weekday_iso) || 1,
            start_local_time: String(window.start_local_time || '').slice(0, 5),
            end_local_time: String(window.end_local_time || '').slice(0, 5),
            sort_order: index,
            active: window.active !== false,
          })),
        },
      };
      if (state.stEditing.id) {
        await api(`/admin/session-types/${encodeURIComponent(state.stEditing.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/admin/session-types', { method: 'POST', body: JSON.stringify(payload) });
      }
      msg(stEditMsg, 'Saved.');
      closeST();
      await loadST();
    } catch (e) {
      msg(stEditMsg, String(e), true);
    } finally {
      state.stSaving = false;
      stSaveBtn.disabled = false;
    }
  }

  async function uploadSTImage(file) {
    if (!file || state.stUploading) return;
    state.stUploading = true;
    msg(stImgMsg, 'Uploading...');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entity_type', 'session');
      const res = await fetch(window.adminClient.resolveUrl('/admin/upload-image'), { method: 'POST', body: fd, credentials: 'include' });
      if (res.status === 401 && window.adminAuth) {
        try { window.adminAuth.handleUnauthorized(401); } catch (_) {}
      }
      const data = await res.json();
      if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`);
      state.stEditing.image_key = data.image_key || null;
      state.stEditing.drive_file_id = data.drive_file_id || null;
      stFImageKey.value = state.stEditing.image_key || '';
      stFDriveId.value = state.stEditing.drive_file_id || '';
      const url = data.url || (data.image_key ? `${R2_BASE}/${data.image_key}` : '');
      if (url) {
        stImgPreview.src = url;
        stImgPreview.classList.remove('hidden');
      }
      msg(stImgMsg, 'Uploaded.');
    } catch (e) {
      msg(stImgMsg, String(e), true);
    } finally {
      state.stUploading = false;
    }
  }

  async function upsertWeekOverride(weekStartDate, mode, overrideWeeklyLimit) {
    if (!state.stEditing || !state.stEditing.id) return;
    msg(stEditMsg, 'Saving override...');
    try {
      const data = await api(
        `/admin/session-types/${encodeURIComponent(state.stEditing.id)}/availability-overrides/${encodeURIComponent(weekStartDate)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            mode,
            override_weekly_booking_limit: overrideWeeklyLimit,
          }),
        },
      );
      const availability = ensureAvailability();
      const nextWeeks = availability.upcoming_weeks.slice();
      const index = nextWeeks.findIndex((week) => week.week_start_date === weekStartDate);
      if (data.week_summary) {
        if (index >= 0) nextWeeks[index] = data.week_summary;
        else nextWeeks.push(data.week_summary);
      }
      availability.upcoming_weeks = nextWeeks;
      renderAvailabilityOverrides();
      msg(stEditMsg, 'Override saved.');
    } catch (e) {
      msg(stEditMsg, String(e), true);
    }
  }

  document.getElementById('stClose').addEventListener('click', closeST);
  stSaveBtn.addEventListener('click', () => { void saveST(); });
  document.getElementById('stAddWindow').addEventListener('click', () => {
    const availability = ensureAvailability();
    availability.windows.push({
      weekday_iso: 4,
      start_local_time: '11:00',
      end_local_time: '13:00',
      sort_order: availability.windows.length,
      active: true,
    });
    renderAvailabilityWindows();
  });
  stWindowsBody.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || !target.dataset) return;
    const index = Number(target.dataset.windowIndex);
    if (!Number.isInteger(index) || !state.stEditing || !state.stEditing.availability || !state.stEditing.availability.windows[index]) return;
    const row = state.stEditing.availability.windows[index];
    if (target.dataset.windowField === 'weekday_iso') row.weekday_iso = Number(target.value) || 1;
    if (target.dataset.windowField === 'start_local_time') row.start_local_time = target.value;
    if (target.dataset.windowField === 'end_local_time') row.end_local_time = target.value;
    if (target.dataset.windowField === 'active') row.active = Boolean(target.checked);
  });
  stWindowsBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-window]');
    if (!button || !state.stEditing || !state.stEditing.availability) return;
    const index = Number(button.dataset.removeWindow);
    if (!Number.isInteger(index)) return;
    state.stEditing.availability.windows.splice(index, 1);
    renderAvailabilityWindows();
  });
  stOverridesBody.addEventListener('click', (event) => {
    const overrideButton = event.target.closest('[data-override-week]');
    if (overrideButton) {
      void upsertWeekOverride(
        overrideButton.dataset.overrideWeek,
        overrideButton.dataset.overrideMode,
        null,
      );
      return;
    }
    const limitButton = event.target.closest('[data-override-limit]');
    if (!limitButton) return;
    const weekStartDate = limitButton.dataset.overrideLimit;
    const raw = window.prompt(`Set custom weekly limit for ${weekStartDate}`, '3');
    if (raw == null) return;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit <= 0) {
      msg(stEditMsg, 'Custom limit must be a positive integer.', true);
      return;
    }
    void upsertWeekOverride(weekStartDate, 'AUTO', limit);
  });
  stFImage.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) void uploadSTImage(f);
  });
  stOverlay.addEventListener('click', (e) => { if (e.target === stOverlay) closeST(); });
  document.getElementById('stImageKeyLink').addEventListener('click', () => {
    const k = stFImageKey.value.trim();
    if (k) window.open(`${R2_BASE}/${k}`, '_blank');
  });
  document.getElementById('stDriveIdLink').addEventListener('click', () => {
    const id = stFDriveId.value.trim();
    if (id) window.open(`${DRIVE_BASE}/${id}`, '_blank');
  });

  const evBody = document.getElementById('evBody');
  const evOverlay = document.getElementById('evOverlay');
  const evEditMsg = document.getElementById('evEditMsg');
  const evFTitle = document.getElementById('evFTitle');
  const evFSlug = document.getElementById('evFSlug');
  const evFStatus = document.getElementById('evFStatus');
  const evFCapacity = document.getElementById('evFCapacity');
  const evFStartsAt = document.getElementById('evFStartsAt');
  const evFEndsAt = document.getElementById('evFEndsAt');
  const evFTimezone = document.getElementById('evFTimezone');
  const evFLocation = document.getElementById('evFLocation');
  const evFAddress = document.getElementById('evFAddress');
  const evFMapsUrl = document.getElementById('evFMapsUrl');
  const evFIsPaid = document.getElementById('evFIsPaid');
  const evFPrice = document.getElementById('evFPrice');
  const evFCurrency = document.getElementById('evFCurrency');
  const evFWhatsapp = document.getElementById('evFWhatsapp');
  const evFDesc = document.getElementById('evFDesc');
  const evFSubtitle = document.getElementById('evFSubtitle');
  const evFIntro = document.getElementById('evFIntro');
  const evFWhatToExpect = document.getElementById('evFWhatToExpect');
  const evFTakeaways = document.getElementById('evFTakeaways');
  const evFImage = document.getElementById('evFImage');
  const evFAlt = document.getElementById('evFAlt');
  const evFImageKey = document.getElementById('evFImageKey');
  const evFDriveId = document.getElementById('evFDriveId');
  const evImgMsg = document.getElementById('evImgMsg');
  const evImgPreview = document.getElementById('evImgPreview');
  const evSaveBtn = document.getElementById('evSave');

  setStatusOptions(evFStatus, EVENT_STATUSES);

  function renderEV() {
    evBody.innerHTML = '';
    let rows = state.evRows;
    if (state.evSearch) rows = rows.filter((r) => (r.title + ' ' + r.status + ' ' + (r.location_name || '')).toLowerCase().includes(state.evSearch));
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'muted';
      td.textContent = 'No rows.';
      tr.appendChild(td);
      evBody.appendChild(tr);
      return;
    }
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.appendChild(cell(r.title));
      tr.appendChild(cell(r.starts_at ? new Date(r.starts_at).toLocaleDateString() : ''));
      tr.appendChild(cell(r.status));
      tr.appendChild(cell(String(r.capacity || '')));
      tr.addEventListener('click', () => openEV(r));
      evBody.appendChild(tr);
    }
  }

  async function loadEvents() {
    msg(statusEl, 'Loading...');
    try {
      const data = await api('/admin/events/all');
      state.evRows = data.events || [];
      renderEV();
      msg(statusEl, 'Ready.');
    } catch (e) {
      msg(statusEl, String(e), true);
    }
  }

  function openEV(row) {
    state.evEditing = row ? { ...row } : {
      title: '', slug: '', description: '', marketing_content: {}, starts_at: '', ends_at: '',
      timezone: 'Europe/Zurich', location_name: '', address_line: '', maps_url: '',
      is_paid: false, price_per_person: null, currency: 'CHF', capacity: 0,
      status: EVENT_STATUSES[0], image_key: null, drive_file_id: null, image_alt: null, whatsapp_group_invite_url: null,
    };
    const ev = state.evEditing;
    const marketing = ev.marketing_content && typeof ev.marketing_content === 'object' ? ev.marketing_content : {};
    evFTitle.value = ev.title || '';
    evFSlug.value = ev.slug || '';
    evFStatus.value = pickAllowedStatus(ev.status, EVENT_STATUSES, EVENT_STATUSES[0]);
    evFCapacity.value = ev.capacity || '';
    evFStartsAt.value = isoToLocal(ev.starts_at);
    evFEndsAt.value = isoToLocal(ev.ends_at);
    evFTimezone.value = ev.timezone || 'Europe/Zurich';
    evFLocation.value = ev.location_name || '';
    evFAddress.value = ev.address_line || '';
    evFMapsUrl.value = ev.maps_url || '';
    evFIsPaid.value = ev.is_paid ? 'true' : 'false';
    evFPrice.value = ev.price_per_person != null ? formatPriceNumber(ev.price_per_person) : '';
    evFCurrency.value = ev.currency || 'CHF';
    evFWhatsapp.value = ev.whatsapp_group_invite_url || '';
    evFDesc.value = ev.description || '';
    evFSubtitle.value = marketing.subtitle || '';
    evFIntro.value = marketing.intro || '';
    evFWhatToExpect.value = joinTextareaList(marketing.what_to_expect);
    evFTakeaways.value = joinTextareaList(marketing.takeaways);
    evFAlt.value = ev.image_alt || '';
    evFImageKey.value = ev.image_key || '';
    evFDriveId.value = ev.drive_file_id || '';
    if (ev.image_key) {
      evImgPreview.src = `${R2_BASE}/${ev.image_key}`;
      evImgPreview.classList.remove('hidden');
    } else {
      evImgPreview.classList.add('hidden');
    }
    evFImage.value = '';
    msg(evEditMsg, '');
    msg(evImgMsg, '');
    evOverlay.classList.remove('hidden');
    evOverlay.setAttribute('aria-hidden', 'false');
  }

  function closeEV() {
    evOverlay.classList.add('hidden');
    evOverlay.setAttribute('aria-hidden', 'true');
  }

  async function saveEV() {
    if (state.evSaving) return;
    state.evSaving = true;
    evSaveBtn.disabled = true;
    msg(evEditMsg, 'Saving...');
    try {
      state.evEditing.image_key = evFImageKey.value.trim() || null;
      state.evEditing.drive_file_id = evFDriveId.value.trim() || null;
      const priceRaw = evFPrice.value.trim();
      const price = priceRaw !== '' ? Number(priceRaw) : null;
      if (price != null && (!Number.isFinite(price) || price < 0)) {
        throw new Error('Price must be a non-negative number.');
      }
      const payload = {
        title: evFTitle.value.trim(),
        slug: evFSlug.value.trim(),
        description: evFDesc.value.trim(),
        marketing_content: {
          subtitle: evFSubtitle.value.trim(),
          intro: evFIntro.value.trim(),
          what_to_expect: parseTextareaList(evFWhatToExpect.value),
          takeaways: parseTextareaList(evFTakeaways.value),
        },
        status: evFStatus.value,
        capacity: Number(evFCapacity.value) || 0,
        starts_at: evFStartsAt.value ? new Date(evFStartsAt.value).toISOString() : undefined,
        ends_at: evFEndsAt.value ? new Date(evFEndsAt.value).toISOString() : undefined,
        timezone: evFTimezone.value.trim() || 'Europe/Zurich',
        location_name: evFLocation.value.trim() || null,
        address_line: evFAddress.value.trim(),
        maps_url: evFMapsUrl.value.trim(),
        is_paid: evFIsPaid.value === 'true',
        price_per_person: price != null ? normalizePriceValue(price) : null,
        currency: evFCurrency.value.trim() || 'CHF',
        whatsapp_group_invite_url: evFWhatsapp.value.trim() || null,
        image_key: state.evEditing.image_key,
        drive_file_id: state.evEditing.drive_file_id,
        image_alt: evFAlt.value.trim() || null,
      };
      if (!state.evEditing.id) throw new Error('Creating new events is not yet supported here - create via DB.');
      await api(`/admin/events/${encodeURIComponent(state.evEditing.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      msg(evEditMsg, 'Saved.');
      closeEV();
      await loadEvents();
    } catch (e) {
      msg(evEditMsg, String(e), true);
    } finally {
      state.evSaving = false;
      evSaveBtn.disabled = false;
    }
  }

  async function uploadEVImage(file) {
    if (!file || state.evUploading) return;
    state.evUploading = true;
    msg(evImgMsg, 'Uploading...');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entity_type', 'event');
      const res = await fetch(window.adminClient.resolveUrl('/admin/upload-image'), { method: 'POST', body: fd, credentials: 'include' });
      if (res.status === 401 && window.adminAuth) {
        try { window.adminAuth.handleUnauthorized(401); } catch (_) {}
      }
      const data = await res.json();
      if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`);
      state.evEditing.image_key = data.image_key || null;
      state.evEditing.drive_file_id = data.drive_file_id || null;
      evFImageKey.value = state.evEditing.image_key || '';
      evFDriveId.value = state.evEditing.drive_file_id || '';
      const url = data.url || (data.image_key ? `${R2_BASE}/${data.image_key}` : '');
      if (url) {
        evImgPreview.src = url;
        evImgPreview.classList.remove('hidden');
      }
      msg(evImgMsg, 'Uploaded.');
    } catch (e) {
      msg(evImgMsg, String(e), true);
    } finally {
      state.evUploading = false;
    }
  }

  document.getElementById('evClose').addEventListener('click', closeEV);
  evSaveBtn.addEventListener('click', () => { void saveEV(); });
  evFImage.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) void uploadEVImage(f);
  });
  evOverlay.addEventListener('click', (e) => { if (e.target === evOverlay) closeEV(); });
  document.getElementById('evImageKeyLink').addEventListener('click', () => {
    const k = evFImageKey.value.trim();
    if (k) window.open(`${R2_BASE}/${k}`, '_blank');
  });
  document.getElementById('evDriveIdLink').addEventListener('click', () => {
    const id = evFDriveId.value.trim();
    if (id) window.open(`${DRIVE_BASE}/${id}`, '_blank');
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!stOverlay.classList.contains('hidden')) closeST();
    if (!evOverlay.classList.contains('hidden')) closeEV();
  });

  void loadST();
})();

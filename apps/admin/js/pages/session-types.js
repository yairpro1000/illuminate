(function () {
  'use strict';

  const R2_BASE = 'https://images.letsilluminate.co';
  const DRIVE_BASE = 'https://drive.google.com/file/d';
  const SESSION_TYPE_STATUSES = ['draft', 'active', 'hidden'];
  const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'sold_out'];

  const state = {
    tab: 'session-types',
    stRows: [], stSearch: '', stEditing: null, stSaving: false, stUploading: false,
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

  function formatPrice(price, currency) {
    const amount = Number(price || 0);
    const code = String(currency || 'CHF').toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch (_) {
      return `${amount} ${code}`;
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
    if (state.tab === 'session-types') openST(null);
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
  const stSaveBtn = document.getElementById('stSave');

  setStatusOptions(stFStatus, SESSION_TYPE_STATUSES);

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
      tr.addEventListener('click', () => openST(r));
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

  function openST(row) {
    state.stEditing = row ? { ...row } : {
      title: '', slug: '', short_description: '', description: '', duration_minutes: 60, price: 0, currency: 'CHF',
      status: SESSION_TYPE_STATUSES[0], sort_order: 0, image_key: null, image_alt: null, drive_file_id: null,
    };
    stFTitle.value = state.stEditing.title || '';
    stFSlug.value = state.stEditing.slug || '';
    stFShort.value = state.stEditing.short_description || '';
    stFDesc.value = state.stEditing.description || '';
    stFDuration.value = state.stEditing.duration_minutes || 60;
    stFPrice.value = Number(state.stEditing.price || 0);
    stFCurrency.value = state.stEditing.currency || 'CHF';
    stFStatus.value = pickAllowedStatus(state.stEditing.status, SESSION_TYPE_STATUSES, SESSION_TYPE_STATUSES[0]);
    stFSort.value = state.stEditing.sort_order || 0;
    stFAlt.value = state.stEditing.image_alt || '';
    stFImageKey.value = state.stEditing.image_key || '';
    stFDriveId.value = state.stEditing.drive_file_id || '';
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
    msg(stEditMsg, '');
    msg(stImgMsg, '');
    stOverlay.classList.remove('hidden');
    stOverlay.setAttribute('aria-hidden', 'false');
  }

  function closeST() {
    stOverlay.classList.add('hidden');
    stOverlay.setAttribute('aria-hidden', 'true');
  }

  async function saveST() {
    if (state.stSaving) return;
    state.stSaving = true;
    stSaveBtn.disabled = true;
    msg(stEditMsg, 'Saving...');
    try {
      state.stEditing.image_key = stFImageKey.value.trim() || null;
      state.stEditing.drive_file_id = stFDriveId.value.trim() || null;
      const priceRaw = String(stFPrice.value ?? '').trim();
      const price = priceRaw === '' ? 0 : Number(priceRaw);
      if (!Number.isFinite(price) || price < 0 || !Number.isInteger(price)) {
        throw new Error('Price must be a non-negative whole number.');
      }
      const payload = {
        title: stFTitle.value.trim(),
        slug: stFSlug.value.trim(),
        short_description: stFShort.value.trim() || null,
        description: stFDesc.value,
        duration_minutes: Number(stFDuration.value) || 0,
        price,
        currency: stFCurrency.value.trim() || 'CHF',
        status: stFStatus.value,
        sort_order: Number(stFSort.value) || 0,
        image_key: state.stEditing.image_key,
        image_alt: stFAlt.value.trim() || null,
        drive_file_id: state.stEditing.drive_file_id,
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

  document.getElementById('stClose').addEventListener('click', closeST);
  stSaveBtn.addEventListener('click', () => { void saveST(); });
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
      title: '', slug: '', description: '', starts_at: '', ends_at: '',
      timezone: 'Europe/Zurich', location_name: '', address_line: '', maps_url: '',
      is_paid: false, price_per_person_cents: null, currency: 'CHF', capacity: 0,
      status: EVENT_STATUSES[0], image_key: null, drive_file_id: null, image_alt: null, whatsapp_group_invite_url: null,
    };
    const ev = state.evEditing;
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
    evFPrice.value = ev.price_per_person_cents != null ? ev.price_per_person_cents : '';
    evFCurrency.value = ev.currency || 'CHF';
    evFWhatsapp.value = ev.whatsapp_group_invite_url || '';
    evFDesc.value = ev.description || '';
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
      const payload = {
        title: evFTitle.value.trim(),
        slug: evFSlug.value.trim(),
        description: evFDesc.value.trim(),
        status: evFStatus.value,
        capacity: Number(evFCapacity.value) || 0,
        starts_at: evFStartsAt.value ? new Date(evFStartsAt.value).toISOString() : undefined,
        ends_at: evFEndsAt.value ? new Date(evFEndsAt.value).toISOString() : undefined,
        timezone: evFTimezone.value.trim() || 'Europe/Zurich',
        location_name: evFLocation.value.trim() || null,
        address_line: evFAddress.value.trim(),
        maps_url: evFMapsUrl.value.trim(),
        is_paid: evFIsPaid.value === 'true',
        price_per_person_cents: priceRaw !== '' ? Number(priceRaw) : null,
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

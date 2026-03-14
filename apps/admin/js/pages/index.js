(function () {
  'use strict';

  const state = {
    allRows: [],
    rows: [],
    editing: null,
    saving: false,
    loadingRows: false,
    rotatingLateAccess: false,
    search: '',
  };

  const statusEl = document.getElementById('status');
  const sourceEl = document.getElementById('source');
  const eventWrapEl = document.getElementById('eventWrap');
  const dateWrapEl = document.getElementById('dateWrap');
  const clientWrapEl = document.getElementById('clientWrap');
  const eventActionsCardEl = document.getElementById('eventActionsCard');
  const eventEl = document.getElementById('eventId');
  const dateEl = document.getElementById('date');
  const clientNameEl = document.getElementById('clientName');
  const rowsBody = document.getElementById('rowsBody');
  const lateAccessInfoEl = document.getElementById('lateAccessInfo');
  const rotateLateAccessEl = document.getElementById('rotateLateAccess');

  const editOverlayEl = document.getElementById('editOverlay');
  const editFirstNameEl = document.getElementById('editFirstName');
  const editLastNameEl = document.getElementById('editLastName');
  const editEmailEl = document.getElementById('editEmail');
  const editPhoneEl = document.getElementById('editPhone');
  const editStatusEl = document.getElementById('editStatus');
  const editNotesEl = document.getElementById('editNotes');
  const editMsgEl = document.getElementById('editMsg');
  const editSaveEl = document.getElementById('editSave');
  const editReadonlyDetailsEl = document.getElementById('editReadonlyDetails');

  function api(path, init) {
    return window.adminClient.requestJson(path, init);
  }

  function setStatus(text, isError) {
    statusEl.className = isError ? 'status err' : 'status ok';
    statusEl.textContent = text || '';
  }

  function setEditMessage(text, isError) {
    editMsgEl.className = isError ? 'status err' : 'status muted';
    editMsgEl.textContent = text || '';
  }

  function createCell(text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function clientOptionParts(row) {
    return {
      firstName: String(row.client_first_name || '').trim(),
      lastName: String(row.client_last_name || '').trim(),
      email: String(row.client_email || '').trim(),
    };
  }

  function clientOptionLabel(row) {
    const { firstName, lastName, email } = clientOptionParts(row);
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (fullName && email) return `${fullName} (${email})`;
    if (fullName) return fullName;
    if (email) return email;
    return String(row.client_id || '').trim();
  }

  function clientOptionKey(row) {
    const { firstName, lastName, email } = clientOptionParts(row);
    const fallback = String(row.client_id || '').trim().toLowerCase();
    return [firstName.toLowerCase(), lastName.toLowerCase(), email.toLowerCase()].join('|') || fallback;
  }

  function populateClientDropdown() {
    const selected = clientNameEl.value;
    const clients = new Map();
    for (const row of state.allRows) {
      const key = clientOptionKey(row);
      const label = clientOptionLabel(row);
      if (key && label && !clients.has(key)) clients.set(key, label);
    }
    const sorted = [...clients.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    clientNameEl.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All clients';
    clientNameEl.appendChild(allOpt);
    for (const [id, name] of sorted) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      clientNameEl.appendChild(opt);
    }
    if (selected && [...clientNameEl.options].some((o) => o.value === selected)) {
      clientNameEl.value = selected;
    }
  }

  function applyClientFilter() {
    const selectedKey = clientNameEl.value;
    let rows = selectedKey
      ? state.allRows.filter((r) => clientOptionKey(r) === selectedKey)
      : [...state.allRows];
    if (state.search) {
      const q = state.search;
      rows = rows.filter((r) => {
        const haystack = [
          r.client_first_name, r.client_last_name, r.client_email,
          r.client_phone, r.notes, r.current_status, r.event_title, r.session_type_title,
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }
    state.rows = rows;
    renderRows();
  }

  function renderRows() {
    rowsBody.innerHTML = '';
    if (!Array.isArray(state.rows) || state.rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'muted';
      td.textContent = 'No rows.';
      tr.appendChild(td);
      rowsBody.appendChild(tr);
      return;
    }

    for (const row of state.rows) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      const fullName = [row.client_first_name || '', row.client_last_name || ''].join(' ').trim();
      tr.appendChild(createCell(row.event_id ? (row.event_title || 'Event') : (row.session_type_title || 'Session')));
      tr.appendChild(createCell(new Date(row.starts_at).toLocaleString()));
      tr.appendChild(createCell(fullName));
      tr.appendChild(createCell(row.client_email || ''));
      tr.appendChild(createCell(row.current_status || ''));
      tr.appendChild(createCell(row.notes || '', 'notes-cell'));
      tr.addEventListener('click', () => openEditModal(row));
      rowsBody.appendChild(tr);
    }
  }

  function detailRow(label, value) {
    const safe = (value == null || value === '') ? '—' : value;
    return `<tr><td>${label}</td><td>${safe}</td></tr>`;
  }

  function detailSection(title) {
    return `<tr><td colspan="2" style="font-weight:700;padding-top:12px;color:var(--ink)">${title}</td></tr>`;
  }

  function fmtDateTime(value) {
    return value ? new Date(value).toLocaleString() : '—';
  }

  function renderReadonlyDetails(row) {
    const kindLabel = row.event_id ? 'Event booking' : '1:1 booking';
    const title = row.event_id ? (row.event_title || 'Event') : (row.session_type_title || 'Session');
    const maps = row.maps_url ? `<a href="${row.maps_url}" target="_blank" rel="noreferrer">Open map</a>` : '—';
    const paymentAmount = (row.payment_amount_cents != null && row.payment_currency)
      ? `${(row.payment_amount_cents / 100).toFixed(2)} ${row.payment_currency}`
      : '—';
    return [
      detailSection('Booking'),
      detailRow('Booking ID', row.booking_id),
      detailRow('Booking type', kindLabel),
      detailRow('Title', title),
      detailRow('Latest booking event', row.latest_event_type || '—'),
      detailRow('Latest booking event at', fmtDateTime(row.latest_event_at)),
      detailRow('Status', row.current_status || '—'),
      detailRow('Starts at', fmtDateTime(row.starts_at)),
      detailRow('Ends at', fmtDateTime(row.ends_at)),
      detailRow('Timezone', row.timezone || '—'),
      detailRow('Address', row.address_line || '—'),
      detailRow('Map', maps),
      detailRow('Latest side-effect attempt', row.latest_side_effect_attempt_status || '—'),
      detailRow('Latest side-effect attempt at', fmtDateTime(row.latest_side_effect_attempt_at)),
      detailRow('Google event ID', row.google_event_id || '—'),
      detailRow('Event ID', row.event_id || '—'),
      detailRow('Session type ID', row.session_type_id || '—'),
      detailRow('Created', fmtDateTime(row.created_at)),
      detailRow('Updated', fmtDateTime(row.updated_at)),
      detailSection('Payment'),
      detailRow('Amount', paymentAmount),
      detailRow('Payment status', row.payment_status || '—'),
      detailRow('Payment booking event', row.payment_latest_event_type || '—'),
      detailRow('Payment event datetime', fmtDateTime(row.payment_latest_event_at)),
      detailRow('Payment side-effect attempt', row.payment_latest_side_effect_attempt_status || '—'),
      detailRow('Payment side-effect at', fmtDateTime(row.payment_latest_side_effect_attempt_at)),
    ].join('');
  }

  function syncSourceMode() {
    const source = sourceEl.value;
    const isEvent = source === 'event';
    eventWrapEl.classList.toggle('hidden', !isEvent);
    eventActionsCardEl.classList.toggle('hidden', !isEvent);
    dateWrapEl.classList.toggle('hidden', isEvent);
    clientWrapEl.classList.toggle('hidden', isEvent);
    rotateLateAccessEl.disabled = !isEvent || !eventEl.value || state.rotatingLateAccess;
    if (!isEvent) {
      lateAccessInfoEl.textContent = 'Late-access links are available for event mode.';
      lateAccessInfoEl.className = 'small muted';
    } else if (!eventEl.value) {
      lateAccessInfoEl.textContent = 'Select an event to generate late-access URL.';
      lateAccessInfoEl.className = 'small muted';
    }
  }

  async function loadEvents() {
    const data = await api('/admin/events');
    const events = Array.isArray(data.events) ? data.events : [];
    const current = eventEl.value;
    eventEl.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All events';
    eventEl.appendChild(allOption);
    for (const ev of events) {
      const opt = document.createElement('option');
      opt.value = ev.id;
      const date = ev.starts_at ? new Date(ev.starts_at).toLocaleDateString() : '';
      opt.textContent = `${ev.title} ${date ? `(${date})` : ''}`;
      eventEl.appendChild(opt);
    }
    if (current && events.some((ev) => ev.id === current)) eventEl.value = current;
    syncSourceMode();
  }

  async function loadRows() {
    state.loadingRows = true;
    try {
      const p = new URLSearchParams();
      const source = sourceEl.value;
      p.set('source', source);
      if (source === 'event' && eventEl.value) p.set('event_id', eventEl.value);
      if (source === 'session' && dateEl.value) p.set('date', dateEl.value);

      const data = await api(`/admin/bookings?${p.toString()}`);
      state.allRows = Array.isArray(data.rows) ? data.rows : [];
      if (source === 'session') populateClientDropdown();
      applyClientFilter();
      setStatus(`Loaded ${state.allRows.length} bookings.`, false);
    } catch (err) {
      state.allRows = [];
      state.rows = [];
      renderRows();
      setStatus(String(err), true);
    } finally {
      state.loadingRows = false;
    }
  }

  async function rotateLateAccess() {
    if (!eventEl.value || state.rotatingLateAccess) return;
    state.rotatingLateAccess = true;
    rotateLateAccessEl.disabled = true;
    lateAccessInfoEl.className = 'small muted';
    lateAccessInfoEl.textContent = 'Generating late-access URL...';
    try {
      const data = await api(`/admin/events/${encodeURIComponent(eventEl.value)}/late-access-links`, {
        method: 'POST',
      });
      lateAccessInfoEl.className = 'small';
      lateAccessInfoEl.innerHTML = `<a href="${data.url}" target="_blank" rel="noreferrer">Open late-access link</a> · Expires ${new Date(data.expires_at).toLocaleString()}`;
      setStatus('Late-access link rotated.', false);
    } catch (err) {
      lateAccessInfoEl.className = 'small err';
      lateAccessInfoEl.textContent = String(err);
      setStatus(String(err), true);
    } finally {
      state.rotatingLateAccess = false;
      syncSourceMode();
    }
  }

  function openEditModal(row) {
    state.editing = row;
    editReadonlyDetailsEl.innerHTML = renderReadonlyDetails(row);
    editFirstNameEl.value = row.client_first_name || '';
    editLastNameEl.value = row.client_last_name || '';
    editEmailEl.value = row.client_email || '';
    editPhoneEl.value = row.client_phone || '';
    editStatusEl.value = row.current_status || 'PENDING';
    editNotesEl.value = row.notes || '';
    setEditMessage('', false);
    editOverlayEl.classList.remove('hidden');
    editOverlayEl.setAttribute('aria-hidden', 'false');
  }

  function closeEditModal() {
    state.editing = null;
    setEditMessage('', false);
    editOverlayEl.classList.add('hidden');
    editOverlayEl.setAttribute('aria-hidden', 'true');
  }

  async function saveEdit() {
    if (!state.editing || state.saving) return;
    state.saving = true;
    editSaveEl.disabled = true;
    setEditMessage('Saving...', false);

    try {
      await api(`/admin/bookings/${encodeURIComponent(state.editing.booking_id)}`, {
        method: 'POST',
        body: JSON.stringify({
          client: {
            first_name: editFirstNameEl.value.trim(),
            last_name: editLastNameEl.value.trim() || null,
            email: editEmailEl.value.trim(),
            phone: editPhoneEl.value.trim() || null,
          },
          booking: {
            current_status: editStatusEl.value,
            notes: editNotesEl.value || null,
          },
        }),
      });

      setEditMessage('Saved.', false);
      closeEditModal();
      await loadRows();
    } catch (err) {
      setEditMessage(String(err), true);
    } finally {
      state.saving = false;
      editSaveEl.disabled = false;
    }
  }

  async function openManageBooking() {
    if (!state.editing || state.saving) return;
    state.saving = true;
    setEditMessage('Generating manage link...', false);
    try {
      const data = await api(`/admin/bookings/${encodeURIComponent(state.editing.booking_id)}/manage-link`, {
        method: 'POST',
      });
      if (data && data.url) window.open(data.url, '_blank', 'noopener,noreferrer');
      setEditMessage('Manage link opened in new tab.', false);
    } catch (err) {
      setEditMessage(String(err), true);
    } finally {
      state.saving = false;
    }
  }

  async function copyClientManageLink() {
    if (!state.editing || state.saving) return;
    state.saving = true;
    setEditMessage('Generating client manage link...', false);
    try {
      const data = await api(`/admin/bookings/${encodeURIComponent(state.editing.booking_id)}/client-manage-link`, {
        method: 'POST',
      });
      const url = data && data.url ? String(data.url) : '';
      if (!url) throw new Error('No URL returned');
      await navigator.clipboard.writeText(url);
      setEditMessage('Client manage link copied to clipboard.', false);
    } catch (err) {
      setEditMessage(String(err), true);
    } finally {
      state.saving = false;
    }
  }

  sourceEl.addEventListener('change', () => {
    syncSourceMode();
    void loadRows();
  });

  eventEl.addEventListener('change', () => {
    syncSourceMode();
    void loadRows();
  });

  clientNameEl.addEventListener('change', () => {
    applyClientFilter();
  });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    applyClientFilter();
  });

  document.getElementById('loadRows').addEventListener('click', () => {
    void loadRows();
  });

  document.getElementById('rotateLateAccess').addEventListener('click', () => {
    void rotateLateAccess();
  });

  document.getElementById('editClose').addEventListener('click', closeEditModal);
  document.getElementById('editSave').addEventListener('click', () => { void saveEdit(); });
  document.getElementById('editOpenManage').addEventListener('click', () => { void openManageBooking(); });
  document.getElementById('editCopyClientManage').addEventListener('click', () => { void copyClientManageLink(); });

  editOverlayEl.addEventListener('click', (e) => {
    if (e.target === editOverlayEl) closeEditModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !editOverlayEl.classList.contains('hidden')) closeEditModal();
  });

  state.allRows = [{
    booking_id: 'test-001',
    event_id: null,
    session_type_id: 'session-type-001',
    starts_at: new Date(Date.now() + 86400000).toISOString(),
    client_id: 'client-001',
    client_first_name: 'Jane',
    client_last_name: 'Doe',
    client_email: 'jane@example.com',
    client_phone: '+1 555 0100',
    current_status: 'CONFIRMED',
    notes: 'Bring portfolio to session',
    event_title: null,
    session_type_title: 'Private Session',
  }];
  state.rows = [...state.allRows];
  renderRows();

  syncSourceMode();
  loadEvents()
    .then(() => loadRows())
    .then(() => setStatus('Ready.', false))
    .catch((err) => setStatus(String(err), true));
})();

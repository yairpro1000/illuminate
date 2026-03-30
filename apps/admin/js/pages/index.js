(function () {
  'use strict';

  const state = {
    allRows: [],
    rows: [],
    sortKey: 'starts_at',
    sortDir: 'asc',
    editing: null,
    saving: false,
    loadingRows: false,
    rotatingLateAccess: false,
    search: '',
    autoSaveTimer: null,
    forcedClientId: '',
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
  const bookingStatusFilterEl = document.getElementById('bookingStatusFilter');
  const rowsBody = document.getElementById('rowsBody');
  const lateAccessInfoEl = document.getElementById('lateAccessInfo');
  const rotateLateAccessEl = document.getElementById('rotateLateAccess');

  const editOverlayEl = document.getElementById('editOverlay');
  const editFirstNameEl = document.getElementById('editFirstName');
  const editLastNameEl = document.getElementById('editLastName');
  const editEmailEl = document.getElementById('editEmail');
  const editPhoneEl = document.getElementById('editPhone');
  const editStatusEl = document.getElementById('editStatus');
  const editPriceEl = document.getElementById('editPrice');
  const editNotesEl = document.getElementById('editNotes');
  const editSettlementNoteEl = document.getElementById('editSettlementNote');
  const editMsgEl = document.getElementById('editMsg');
  const editSaveEl = document.getElementById('editSave');
  const editSetCashOkEl = document.getElementById('editSetCashOk');
  const editSettlePaymentEl = document.getElementById('editSettlePayment');
  const editReadonlyDetailsEl = document.getElementById('editReadonlyDetails');

  function readForcedClientId() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      return String(params.get('client_id') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function api(path, init) {
    return window.adminClient.requestJson(path, init);
  }

  function setStatus(text, isError) {
    statusEl.className = isError ? 'status err' : 'status ok';
    statusEl.textContent = text || '';
  }

  function setEditMessage(text, tone = 'muted') {
    editMsgEl.className = `status ${tone}`;
    editMsgEl.textContent = text || '';
  }

  function syncEditActionAvailability(row) {
    const canAdjustPaymentStatus = Boolean(
      row.payment_status && row.payment_status !== 'SUCCEEDED' && row.payment_status !== 'REFUNDED',
    );
    editSetCashOkEl.disabled = !canAdjustPaymentStatus || state.saving;
    editSettlePaymentEl.disabled = !canAdjustPaymentStatus || state.saving;
    editSaveEl.disabled = state.saving;
  }

  function syncEditFormFromRow(row, options = {}) {
    const preserveSettlementNote = Boolean(options.preserveSettlementNote);
    state.editing = row;
    editReadonlyDetailsEl.innerHTML = renderReadonlyDetails(row);
    editFirstNameEl.value = row.client_first_name || '';
    editLastNameEl.value = row.client_last_name || '';
    editEmailEl.value = row.client_email || '';
    editPhoneEl.value = row.client_phone || '';
    editStatusEl.value = row.current_status || 'PENDING';
    editPriceEl.value = row.booking_price != null ? String(row.booking_price) : '';
    editNotesEl.value = row.notes || '';
    if (!preserveSettlementNote) editSettlementNoteEl.value = '';
    syncEditActionAvailability(row);
  }

  async function fetchBookingDetail(bookingId) {
    const data = await api(`/admin/bookings/${encodeURIComponent(bookingId)}`);
    return data && data.row ? data.row : null;
  }

  async function refreshEditingRow(bookingId, options = {}) {
    await loadRows();
    const refreshedSummary = state.allRows.find((row) => row.booking_id === bookingId) || null;
    if (!refreshedSummary) {
      state.editing = null;
      setEditMessage('Booking updated, but it is no longer visible in the current filtered list.', 'err');
      return null;
    }
    const refreshed = await fetchBookingDetail(bookingId);
    if (!refreshed) {
      state.editing = null;
      setEditMessage('Booking detail could not be reloaded.', 'err');
      return null;
    }
    syncEditFormFromRow(refreshed, options);
    editOverlayEl.classList.remove('hidden');
    editOverlayEl.setAttribute('aria-hidden', 'false');
    return refreshed;
  }

  function createCell(text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function formatMoneyValue(value) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return number.toFixed(2).replace(/\.00$/, '').replace(/(\.\d*[1-9])0$/, '$1');
  }

  function formatMoneyDisplay(value, currency) {
    if (value == null || !currency) return '—';
    return `${formatMoneyValue(value)} ${currency}`;
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

  function rowTitle(row) {
    return row.event_id ? (row.event_title || 'Event') : (row.session_type_title || 'Session');
  }

  function rowClientName(row) {
    return [row.client_first_name || '', row.client_last_name || ''].join(' ').trim();
  }

  function sortRows(rows) {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      let av;
      let bv;
      switch (state.sortKey) {
        case 'starts_at':
          av = new Date(a.starts_at || 0).getTime();
          bv = new Date(b.starts_at || 0).getTime();
          break;
        case 'title':
          av = rowTitle(a);
          bv = rowTitle(b);
          break;
        case 'client_name':
          av = rowClientName(a);
          bv = rowClientName(b);
          break;
        default:
          av = a[state.sortKey];
          bv = b[state.sortKey];
          break;
      }
      av = typeof av === 'number' ? av : String(av || '').toLowerCase();
      bv = typeof bv === 'number' ? bv : String(bv || '').toLowerCase();
      if (av < bv) return state.sortDir === 'asc' ? -1 : 1;
      if (av > bv) return state.sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
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
    if (state.forcedClientId) {
      const match = state.allRows.find((r) => r.client_id === state.forcedClientId);
      if (match) {
        const key = clientOptionKey(match);
        if ([...clientNameEl.options].some((o) => o.value === key)) {
          clientNameEl.value = key;
        }
      }
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
          r.booking_coupon_code, r.booking_currency, r.booking_price,
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }
    state.rows = sortRows(rows);
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
      const fullName = rowClientName(row);
      tr.appendChild(createCell(rowTitle(row)));
      tr.appendChild(createCell(new Date(row.starts_at).toLocaleString()));
      tr.appendChild(createCell(fullName));
      tr.appendChild(createCell(row.client_email || ''));
      tr.appendChild(createCell(row.current_status || ''));
      tr.appendChild(createCell(row.notes || '', 'notes-cell'));
      tr.addEventListener('click', () => { void openEditModal(row); });
      rowsBody.appendChild(tr);
    }
  }

  function detailRow(label, value) {
    const safe = (value == null || value === '') ? '—' : value;
    return `<tr><td>${label}</td><td>${safe}</td></tr>`;
  }

  function detailLink(url, label) {
    if (!url) return '—';
    return `<a href="${url}" target="_blank" rel="noreferrer">${label || 'Open'}</a>`;
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
    const bookingAmount = formatMoneyDisplay(row.booking_price, row.booking_currency);
    const paymentAmount = (row.payment_amount != null && row.payment_currency)
      ? formatMoneyDisplay(row.payment_amount, row.payment_currency)
      : '—';
    return [
      detailSection('Booking'),
      detailRow('Booking ID', row.booking_id),
      detailRow('Booking type', kindLabel),
      detailRow('Title', title),
      detailRow('Booked price', bookingAmount),
      detailRow('Coupon code', row.booking_coupon_code || '—'),
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
      detailRow('Provider', row.payment_provider || '—'),
      detailRow('Checkout URL', detailLink(row.payment_checkout_url, 'Open checkout')),
      detailRow('Invoice URL', detailLink(row.payment_invoice_url, 'Open invoice')),
      detailRow('Refund status', row.payment_refund_status || '—'),
      detailRow(
        'Refund amount',
        (row.payment_refund_amount != null && row.payment_refund_currency)
          ? formatMoneyDisplay(row.payment_refund_amount, row.payment_refund_currency)
          : '—',
      ),
      detailRow('Stripe customer ID', row.payment_stripe_customer_id || '—'),
      detailRow('Stripe checkout session', row.payment_stripe_checkout_session_id || '—'),
      detailRow('Stripe payment intent', row.payment_stripe_payment_intent_id || '—'),
      detailRow('Stripe invoice', row.payment_stripe_invoice_id || '—'),
      detailRow('Stripe payment link', row.payment_stripe_payment_link_id || '—'),
      detailRow('Stripe refund', row.payment_stripe_refund_id || '—'),
      detailRow('Stripe credit note', row.payment_stripe_credit_note_id || '—'),
      detailRow('Receipt URL', detailLink(row.payment_stripe_receipt_url, 'View receipt')),
      detailRow('Credit note URL', detailLink(row.payment_stripe_credit_note_url, 'View credit note')),
      detailRow('Paid at', fmtDateTime(row.payment_paid_at)),
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
      if (state.forcedClientId) p.set('client_id', state.forcedClientId);
      if (bookingStatusFilterEl.value) p.set('status', bookingStatusFilterEl.value);

      const data = await api(`/admin/bookings?${p.toString()}`);
      state.allRows = Array.isArray(data.rows) ? data.rows : [];
      populateClientDropdown();
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

  function toggleSort(sortKey) {
    if (state.sortKey === sortKey) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else {
      state.sortKey = sortKey;
      state.sortDir = sortKey === 'starts_at' ? 'asc' : 'asc';
    }
    state.rows = sortRows(state.rows);
    renderRows();
  }

  async function openEditModal(row) {
    state.saving = true;
    setEditMessage('Loading booking details...', 'muted');
    editOverlayEl.classList.remove('hidden');
    editOverlayEl.setAttribute('aria-hidden', 'false');
    try {
      const detail = await fetchBookingDetail(row.booking_id);
      if (!detail) throw new Error('Booking detail could not be loaded');
      syncEditFormFromRow(detail);
      setEditMessage('', 'muted');
    } catch (err) {
      state.editing = null;
      editReadonlyDetailsEl.innerHTML = '';
      setEditMessage(String(err), 'err');
    } finally {
      state.saving = false;
      if (state.editing) syncEditActionAvailability(state.editing);
    }
  }

  function closeEditModal() {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
    state.editing = null;
    setEditMessage('', 'muted');
    editOverlayEl.classList.add('hidden');
    editOverlayEl.setAttribute('aria-hidden', 'true');
  }

  async function saveEdit({ refresh = true } = {}) {
    if (!state.editing || state.saving) return;
    const bookingId = state.editing.booking_id;
    state.saving = true;
    syncEditActionAvailability(state.editing);
    setEditMessage('Saving...', 'muted');

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

      if (refresh) {
        await refreshEditingRow(bookingId);
      }
      setEditMessage('Saved.', 'ok');
    } catch (err) {
      setEditMessage(String(err), 'err');
    } finally {
      state.saving = false;
      if (state.editing) syncEditActionAvailability(state.editing);
    }
  }

  function scheduleAutoSave() {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(() => { void saveEdit({ refresh: false }); }, 1000);
  }

  async function openManageBooking() {
    if (!state.editing || state.saving) return;
    state.saving = true;
    syncEditActionAvailability(state.editing);
    setEditMessage('Generating manage link...', 'muted');
    try {
      const data = await api(`/admin/bookings/${encodeURIComponent(state.editing.booking_id)}/manage-link`, {
        method: 'POST',
      });
      if (data && data.url) window.open(data.url, '_blank', 'noopener,noreferrer');
      setEditMessage('Manage link opened in new tab.', 'ok');
    } catch (err) {
      setEditMessage(String(err), 'err');
    } finally {
      state.saving = false;
      if (state.editing) syncEditActionAvailability(state.editing);
    }
  }

  async function copyClientManageLink() {
    if (!state.editing || state.saving) return;
    state.saving = true;
    syncEditActionAvailability(state.editing);
    setEditMessage('Generating client manage link...', 'muted');
    try {
      const data = await api(`/admin/bookings/${encodeURIComponent(state.editing.booking_id)}/client-manage-link`, {
        method: 'POST',
      });
      const url = data && data.url ? String(data.url) : '';
      if (!url) throw new Error('No URL returned');
      await navigator.clipboard.writeText(url);
      setEditMessage('Client manage link copied to clipboard.', 'ok');
    } catch (err) {
      setEditMessage(String(err), 'err');
    } finally {
      state.saving = false;
      if (state.editing) syncEditActionAvailability(state.editing);
    }
  }

  async function setCashOk() {
    if (!state.editing || state.saving) return;
    const bookingId = state.editing.booking_id;
    state.saving = true;
    syncEditActionAvailability(state.editing);
    setEditMessage('Approving manual arrangement...', 'muted');
    try {
      await api(`/admin/bookings/${encodeURIComponent(state.editing.booking_id)}`, {
        method: 'POST',
        body: JSON.stringify({
          payment: {
            status: 'CASH_OK',
          },
        }),
      });
      await refreshEditingRow(bookingId, { preserveSettlementNote: true });
      setEditMessage('Manual arrangement approved.', 'ok');
    } catch (err) {
      setEditMessage(String(err), 'err');
    } finally {
      state.saving = false;
      if (state.editing) syncEditActionAvailability(state.editing);
    }
  }

  async function settlePayment() {
    if (!state.editing || state.saving) return;
    const bookingId = state.editing.booking_id;
    state.saving = true;
    syncEditActionAvailability(state.editing);
    setEditMessage('Settling payment...', 'muted');
    try {
      await api(`/admin/bookings/${encodeURIComponent(state.editing.booking_id)}/payment-settled`, {
        method: 'POST',
        body: JSON.stringify({
          note: editSettlementNoteEl.value.trim() || null,
          invoice_url: state.editing.payment_invoice_url || null,
        }),
      });
      await refreshEditingRow(bookingId, { preserveSettlementNote: true });
      setEditMessage('Payment settled.', 'ok');
    } catch (err) {
      setEditMessage(String(err), 'err');
    } finally {
      state.saving = false;
      if (state.editing) syncEditActionAvailability(state.editing);
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

  bookingStatusFilterEl.addEventListener('change', () => {
    void loadRows();
  });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    applyClientFilter();
  });

  document.querySelectorAll('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => toggleSort(btn.getAttribute('data-sort')));
  });

  document.getElementById('loadRows').addEventListener('click', () => {
    void loadRows();
  });

  document.getElementById('rotateLateAccess').addEventListener('click', () => {
    void rotateLateAccess();
  });

  [editFirstNameEl, editLastNameEl, editEmailEl, editPhoneEl, editNotesEl].forEach((el) => {
    el.addEventListener('input', scheduleAutoSave);
  });
  editStatusEl.addEventListener('change', scheduleAutoSave);

  document.getElementById('editClose').addEventListener('click', closeEditModal);
  document.getElementById('editSave').addEventListener('click', () => { void saveEdit(); });
  document.getElementById('editSetCashOk').addEventListener('click', () => { void setCashOk(); });
  document.getElementById('editSettlePayment').addEventListener('click', () => { void settlePayment(); });
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
  state.forcedClientId = readForcedClientId();
  if (state.forcedClientId) {
    clientWrapEl.classList.remove('hidden');
    bookingStatusFilterEl.value = '';
  }
  loadEvents()
    .then(() => loadRows())
    .then(() => setStatus('Ready.', false))
    .catch((err) => setStatus(String(err), true));
})();

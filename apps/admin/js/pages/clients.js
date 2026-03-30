(function () {
  'use strict';

  const state = {
    allRows: [],
    rows: [],
    sessionsOnly: false,
    eventsOnly: false,
    editing: null,
    saving: false,
  };

  const statusEl = document.getElementById('status');
  const rowsBody = document.getElementById('rowsBody');
  const sessionsToggleEl = document.getElementById('sessionsToggle');
  const eventsToggleEl = document.getElementById('eventsToggle');
  const createClientEl = document.getElementById('createClient');
  const clientOverlayEl = document.getElementById('clientOverlay');
  const modalTitleEl = document.getElementById('modalTitle');
  const firstNameEl = document.getElementById('firstName');
  const lastNameEl = document.getElementById('lastName');
  const emailEl = document.getElementById('email');
  const phoneEl = document.getElementById('phone');
  const modalStatusEl = document.getElementById('modalStatus');
  const openBookingsEl = document.getElementById('openBookings');
  const bookSessionEl = document.getElementById('bookSession');
  const bookEventEl = document.getElementById('bookEvent');
  const saveClientEl = document.getElementById('saveClient');
  const closeModalEl = document.getElementById('closeModal');

  function api(path, init) {
    return window.adminClient.requestJson(path, init);
  }

  function setStatus(text, isError) {
    statusEl.className = isError ? 'status err' : 'status ok';
    statusEl.textContent = text || '';
  }

  function setModalStatus(text, tone) {
    modalStatusEl.className = `status ${tone || 'muted'}`;
    modalStatusEl.textContent = text || '';
  }

  function fullName(row) {
    return [row.first_name || '', row.last_name || ''].join(' ').trim() || row.email || row.id;
  }

  function fmtDate(value) {
    return value ? new Date(value).toLocaleString() : '—';
  }

  function createCell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function applyFilters() {
    let rows = [...state.allRows];
    if (state.sessionsOnly) rows = rows.filter((row) => Number(row.sessions_count || 0) > 0);
    if (state.eventsOnly) rows = rows.filter((row) => Number(row.events_count || 0) > 0);
    state.rows = rows;
    renderRows();
  }

  function syncToggleUi() {
    sessionsToggleEl.classList.toggle('active', state.sessionsOnly);
    eventsToggleEl.classList.toggle('active', state.eventsOnly);
  }

  function renderRows() {
    rowsBody.innerHTML = '';
    if (!state.rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'muted';
      td.textContent = 'No clients.';
      tr.appendChild(td);
      rowsBody.appendChild(tr);
      return;
    }

    state.rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.appendChild(createCell(fullName(row)));
      tr.appendChild(createCell(row.email || ''));
      tr.appendChild(createCell(row.phone || '—'));
      tr.appendChild(createCell(String(row.sessions_count || 0)));
      tr.appendChild(createCell(fmtDate(row.last_session_at)));
      tr.appendChild(createCell(String(row.events_count || 0)));
      tr.appendChild(createCell(fmtDate(row.last_event_at)));
      tr.addEventListener('click', () => openModal(row));
      rowsBody.appendChild(tr);
    });
  }

  function syncModalButtons() {
    const hasClient = Boolean(state.editing && state.editing.id);
    openBookingsEl.classList.toggle('hidden', !hasClient);
    bookSessionEl.classList.toggle('hidden', !hasClient);
    bookEventEl.classList.toggle('hidden', !hasClient);
    saveClientEl.disabled = state.saving;
  }

  function openModal(row) {
    state.editing = row ? { ...row } : null;
    modalTitleEl.textContent = row ? 'Edit Client' : 'Create Client';
    firstNameEl.value = row && row.first_name ? row.first_name : '';
    lastNameEl.value = row && row.last_name ? row.last_name : '';
    emailEl.value = row && row.email ? row.email : '';
    phoneEl.value = row && row.phone ? row.phone : '';
    setModalStatus('', 'muted');
    syncModalButtons();
    clientOverlayEl.classList.remove('hidden');
    clientOverlayEl.setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    state.editing = null;
    state.saving = false;
    clientOverlayEl.classList.add('hidden');
    clientOverlayEl.setAttribute('aria-hidden', 'true');
    setModalStatus('', 'muted');
  }

  async function loadClients() {
    try {
      const data = await api('/admin/clients');
      state.allRows = Array.isArray(data.rows) ? data.rows : [];
      applyFilters();
      setStatus(`Loaded ${state.allRows.length} clients.`, false);
    } catch (err) {
      state.allRows = [];
      state.rows = [];
      renderRows();
      setStatus(String(err), true);
    }
  }

  async function saveClient() {
    if (state.saving) return;
    state.saving = true;
    syncModalButtons();
    setModalStatus('Saving...', 'muted');
    try {
      const payload = {
        first_name: firstNameEl.value.trim(),
        last_name: lastNameEl.value.trim() || null,
        email: emailEl.value.trim(),
        phone: phoneEl.value.trim() || null,
      };
      const path = state.editing
        ? `/admin/clients/${encodeURIComponent(state.editing.id)}`
        : '/admin/clients';
      const method = state.editing ? 'PATCH' : 'POST';
      await api(path, {
        method,
        body: JSON.stringify(payload),
      });
      await loadClients();
      setModalStatus('Saved.', 'ok');
      if (!state.editing) closeModal();
    } catch (err) {
      setModalStatus(String(err), 'err');
    } finally {
      state.saving = false;
      syncModalButtons();
    }
  }

  async function redirectToRebook(source) {
    if (!state.editing || !state.editing.id || state.saving) return;
    state.saving = true;
    syncModalButtons();
    setModalStatus('Generating booking token...', 'muted');
    try {
      const data = await api(`/admin/clients/${encodeURIComponent(state.editing.id)}/booking-token`, {
        method: 'POST',
      });
      const params = new URLSearchParams({
        source,
        admin_token: String(data.token || ''),
        prefill_first: firstNameEl.value.trim(),
        prefill_last: lastNameEl.value.trim(),
        prefill_email: emailEl.value.trim(),
        prefill_phone: phoneEl.value.trim(),
      });
      window.location.assign(`/rebook.html?${params.toString()}`);
    } catch (err) {
      setModalStatus(String(err), 'err');
      state.saving = false;
      syncModalButtons();
    }
  }

  sessionsToggleEl.addEventListener('click', () => {
    state.sessionsOnly = !state.sessionsOnly;
    syncToggleUi();
    applyFilters();
  });
  eventsToggleEl.addEventListener('click', () => {
    state.eventsOnly = !state.eventsOnly;
    syncToggleUi();
    applyFilters();
  });
  createClientEl.addEventListener('click', () => openModal(null));
  saveClientEl.addEventListener('click', () => { void saveClient(); });
  closeModalEl.addEventListener('click', closeModal);
  openBookingsEl.addEventListener('click', () => {
    if (!state.editing) return;
    window.location.assign(`index.html?client_id=${encodeURIComponent(state.editing.id)}`);
  });
  bookSessionEl.addEventListener('click', () => { void redirectToRebook('session'); });
  bookEventEl.addEventListener('click', () => { void redirectToRebook('event'); });
  clientOverlayEl.addEventListener('click', (event) => {
    if (event.target === clientOverlayEl) closeModal();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !clientOverlayEl.classList.contains('hidden')) closeModal();
  });

  syncToggleUi();
  renderRows();
  void loadClients();
})();

(function () {
  'use strict';

  const state = {
    allRows: [],
    rows: [],
    sortKey: 'created_at',
    sortDir: 'desc',
  };

  const dateEl = document.getElementById('date');
  const clientIdEl = document.getElementById('clientId');
  const qEl = document.getElementById('q');
  const rowsBody = document.getElementById('rowsBody');
  const statusEl = document.getElementById('status');
  const messageOverlayEl = document.getElementById('messageOverlay');
  const messageMetaEl = document.getElementById('messageMeta');
  const messageFullEl = document.getElementById('messageFull');

  function api(path, init) {
    return window.adminClient.requestJson(path, init);
  }

  function setStatus(text, isError) {
    statusEl.className = isError ? 'status err' : 'status ok';
    statusEl.textContent = text || '';
  }

  function createCell(content) {
    const td = document.createElement('td');
    if (typeof content === 'string') td.textContent = content;
    else if (content) td.appendChild(content);
    return td;
  }

  function rowClientName(row) {
    return [row.client_first_name || '', row.client_last_name || ''].join(' ').trim() || row.client_id;
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

  function sortRows(rows) {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      let av = a[state.sortKey];
      let bv = b[state.sortKey];
      if (state.sortKey === 'created_at') {
        av = new Date(av || 0).getTime();
        bv = new Date(bv || 0).getTime();
      } else {
        av = String(av || '').toLowerCase();
        bv = String(bv || '').toLowerCase();
      }
      if (av < bv) return state.sortDir === 'asc' ? -1 : 1;
      if (av > bv) return state.sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  function renderRows() {
    rowsBody.innerHTML = '';
    if (!state.rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'muted';
      td.textContent = 'No messages.';
      tr.appendChild(td);
      rowsBody.appendChild(tr);
      return;
    }

    for (const row of state.rows) {
      const tr = document.createElement('tr');
      tr.appendChild(createCell(new Date(row.created_at).toLocaleString()));
      tr.appendChild(createCell(row.client_first_name || ''));
      tr.appendChild(createCell(row.client_last_name || ''));

      const emailLink = document.createElement('a');
      emailLink.href = 'mailto:' + (row.client_email || '');
      emailLink.textContent = row.client_email || '';
      tr.appendChild(createCell(emailLink));

      const phoneValue = row.client_phone || '';
      if (phoneValue) {
        const phoneLink = document.createElement('a');
        phoneLink.href = 'tel:' + phoneValue;
        phoneLink.textContent = phoneValue;
        tr.appendChild(createCell(phoneLink));
      } else {
        tr.appendChild(createCell(''));
      }

      const msgBtn = document.createElement('button');
      msgBtn.type = 'button';
      msgBtn.className = 'message-preview';
      msgBtn.textContent = row.message || '';
      msgBtn.title = 'Open full message';
      msgBtn.addEventListener('click', () => openMessageModal(row));
      tr.appendChild(createCell(msgBtn));

      rowsBody.appendChild(tr);
    }
  }

  function populateClientDropdown() {
    const selected = clientIdEl.value;
    const clients = new Map();
    for (const row of state.allRows) {
      const key = clientOptionKey(row);
      const label = clientOptionLabel(row);
      if (key && label && !clients.has(key)) clients.set(key, label);
    }
    const sorted = [...clients.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    clientIdEl.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All clients';
    clientIdEl.appendChild(allOpt);
    for (const entry of sorted) {
      const opt = document.createElement('option');
      opt.value = entry[0];
      opt.textContent = entry[1];
      clientIdEl.appendChild(opt);
    }
    if (selected && [...clientIdEl.options].some((o) => o.value === selected)) {
      clientIdEl.value = selected;
    }
  }

  function openMessageModal(row) {
    messageMetaEl.textContent = rowClientName(row) + ' · ' + new Date(row.created_at).toLocaleString();
    messageFullEl.textContent = row.message || '';
    messageOverlayEl.classList.remove('hidden');
    messageOverlayEl.setAttribute('aria-hidden', 'false');
  }

  function closeMessageModal() {
    messageOverlayEl.classList.add('hidden');
    messageOverlayEl.setAttribute('aria-hidden', 'true');
    messageFullEl.textContent = '';
    messageMetaEl.textContent = '';
  }

  async function loadRows() {
    setStatus('Loading messages...', false);
    try {
      const params = new URLSearchParams();
      if (dateEl.value) params.set('date', dateEl.value);
      if (clientIdEl.value) params.set('client_id', clientIdEl.value);
      const q = qEl.value.trim();
      if (q) params.set('q', q);
      const suffix = params.toString() ? '?' + params.toString() : '';
      const data = await api('/admin/contact-messages' + suffix);
      state.allRows = Array.isArray(data.rows) ? data.rows : [];
      populateClientDropdown();
      state.rows = sortRows(state.allRows);
      renderRows();
      setStatus('Loaded ' + state.rows.length + ' messages.', false);
    } catch (err) {
      state.allRows = [];
      state.rows = [];
      renderRows();
      setStatus(String(err), true);
    }
  }

  function toggleSort(sortKey) {
    if (state.sortKey === sortKey) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else {
      state.sortKey = sortKey;
      state.sortDir = sortKey === 'created_at' ? 'desc' : 'asc';
    }
    state.rows = sortRows(state.allRows);
    renderRows();
  }

  document.getElementById('loadRows').addEventListener('click', () => { void loadRows(); });
  clientIdEl.addEventListener('change', () => { void loadRows(); });
  document.querySelectorAll('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => toggleSort(btn.getAttribute('data-sort')));
  });
  document.getElementById('closeMessage').addEventListener('click', closeMessageModal);
  messageOverlayEl.addEventListener('click', (e) => {
    if (e.target === messageOverlayEl) closeMessageModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !messageOverlayEl.classList.contains('hidden')) closeMessageModal();
  });

  void loadRows();
})();

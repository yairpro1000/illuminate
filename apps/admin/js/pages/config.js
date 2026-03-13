(function () {
  'use strict';

  const NEW_DOMAIN_VALUE = '__enter_new__';

  const state = {
    rows: [],
    domains: [],
    valueTypes: ['integer', 'float', 'boolean', 'text', 'json'],
    editingOriginalKeyname: null,
    saving: false,
  };

  const statusEl = document.getElementById('status');
  const configPathEl = document.getElementById('configPath');
  const timingBodyEl = document.getElementById('timingBody');
  const addSettingBtnEl = document.getElementById('addSettingBtn');

  const editOverlayEl = document.getElementById('editOverlay');
  const editTitleEl = document.getElementById('editTitle');
  const editMsgEl = document.getElementById('editMsg');
  const editSaveEl = document.getElementById('editSave');
  const editCloseEl = document.getElementById('editClose');
  const editDomainSelectEl = document.getElementById('editDomainSelect');
  const editDomainCustomWrapEl = document.getElementById('editDomainCustomWrap');
  const editDomainCustomEl = document.getElementById('editDomainCustom');
  const editKeynameEl = document.getElementById('editKeyname');
  const editReadableNameEl = document.getElementById('editReadableName');
  const editValueTypeEl = document.getElementById('editValueType');
  const editUnitEl = document.getElementById('editUnit');
  const editValueEl = document.getElementById('editValue');
  const editDescriptionEl = document.getElementById('editDescription');
  const editDescriptionHeEl = document.getElementById('editDescriptionHe');

  function api(path, init) {
    return window.adminClient.requestJson(path, init);
  }

  function setStatus(text, type) {
    statusEl.className = 'status ' + (type || 'muted');
    statusEl.textContent = text || '';
  }

  function setEditMessage(text, type) {
    editMsgEl.className = 'status ' + (type || 'muted');
    editMsgEl.textContent = text || '';
  }

  function makeCell(label, content) {
    const td = document.createElement('td');
    td.setAttribute('data-label', label);
    if (content instanceof Node) {
      td.appendChild(content);
    } else {
      td.textContent = content;
    }
    return td;
  }

  function makeCode(text) {
    const code = document.createElement('code');
    code.textContent = text;
    return code;
  }

  function makeValuePill(value) {
    const pill = document.createElement('span');
    pill.className = 'value-pill';
    pill.textContent = String(value);
    return pill;
  }

  function sortRows(rows) {
    return rows.slice().sort((a, b) => {
      const aNum = Number(a.value);
      const bNum = Number(b.value);
      const aIsNum = Number.isFinite(aNum);
      const bIsNum = Number.isFinite(bNum);
      if (aIsNum && bIsNum) {
        return aNum - bNum || String(a.name || '').localeCompare(String(b.name || ''));
      }
      if (aIsNum) return -1;
      if (bIsNum) return 1;
      return String(a.value || '').localeCompare(String(b.value || '')) || String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function renderRows() {
    timingBodyEl.innerHTML = '';
    const rows = sortRows(state.rows);

    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'empty-state';
      td.textContent = 'No system settings were returned.';
      tr.appendChild(td);
      timingBodyEl.appendChild(tr);
      return;
    }

    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.appendChild(makeCell('Name', row.name || ''));
      tr.appendChild(makeCell('Keyname', makeCode(row.keyname || '')));
      tr.appendChild(makeCell('Value', makeValuePill(row.value)));
      tr.appendChild(makeCell('Description', row.description_display || row.description_he || row.description || ''));
      tr.addEventListener('click', () => openEditModal(row));
      timingBodyEl.appendChild(tr);
    }
  }

  function populateDomainOptions(selectedDomain) {
    editDomainSelectEl.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select domain';
    editDomainSelectEl.appendChild(placeholder);

    for (const domain of state.domains) {
      const option = document.createElement('option');
      option.value = domain;
      option.textContent = domain;
      editDomainSelectEl.appendChild(option);
    }

    const customOption = document.createElement('option');
    customOption.value = NEW_DOMAIN_VALUE;
    customOption.textContent = 'Enter new';
    editDomainSelectEl.appendChild(customOption);

    if (selectedDomain && state.domains.includes(selectedDomain)) {
      editDomainSelectEl.value = selectedDomain;
      editDomainCustomEl.value = '';
    } else if (selectedDomain) {
      editDomainSelectEl.value = NEW_DOMAIN_VALUE;
      editDomainCustomEl.value = selectedDomain;
    } else {
      editDomainSelectEl.value = '';
      editDomainCustomEl.value = '';
    }
    syncDomainInputVisibility();
  }

  function populateValueTypeOptions(selectedValueType) {
    editValueTypeEl.innerHTML = '';
    for (const valueType of state.valueTypes) {
      const option = document.createElement('option');
      option.value = valueType;
      option.textContent = valueType;
      editValueTypeEl.appendChild(option);
    }
    editValueTypeEl.value = selectedValueType || state.valueTypes[0];
  }

  function syncDomainInputVisibility() {
    const showCustom = editDomainSelectEl.value === NEW_DOMAIN_VALUE;
    editDomainCustomWrapEl.classList.toggle('hidden', !showCustom);
  }

  function openEditModal(row) {
    state.editingOriginalKeyname = row.keyname || null;
    editTitleEl.textContent = 'Edit setting';
    populateDomainOptions(row.domain || '');
    populateValueTypeOptions(row.value_type || state.valueTypes[0]);
    editKeynameEl.value = row.keyname || '';
    editReadableNameEl.value = row.readable_name || row.name || '';
    editUnitEl.value = row.unit || '';
    editValueEl.value = row.value == null ? '' : String(row.value);
    editDescriptionEl.value = row.description || '';
    editDescriptionHeEl.value = row.description_he || '';
    setEditMessage('', 'muted');
    editOverlayEl.classList.remove('hidden');
    editOverlayEl.setAttribute('aria-hidden', 'false');
  }

  function openCreateModal() {
    state.editingOriginalKeyname = null;
    editTitleEl.textContent = 'Add setting';
    populateDomainOptions('');
    populateValueTypeOptions(state.valueTypes[0]);
    editKeynameEl.value = '';
    editReadableNameEl.value = '';
    editUnitEl.value = '';
    editValueEl.value = '';
    editDescriptionEl.value = '';
    editDescriptionHeEl.value = '';
    setEditMessage('', 'muted');
    editOverlayEl.classList.remove('hidden');
    editOverlayEl.setAttribute('aria-hidden', 'false');
  }

  function closeEditModal(force) {
    if (state.saving && !force) return;
    editOverlayEl.classList.add('hidden');
    editOverlayEl.setAttribute('aria-hidden', 'true');
  }

  function readDomainValue() {
    if (editDomainSelectEl.value === NEW_DOMAIN_VALUE) {
      return editDomainCustomEl.value.trim();
    }
    return editDomainSelectEl.value.trim();
  }

  function collectPayload() {
    return {
      original_keyname: state.editingOriginalKeyname,
      domain: readDomainValue(),
      keyname: editKeynameEl.value.trim(),
      readable_name: editReadableNameEl.value.trim(),
      value_type: editValueTypeEl.value,
      unit: editUnitEl.value.trim(),
      value: editValueEl.value,
      description: editDescriptionEl.value.trim(),
      description_he: editDescriptionHeEl.value.trim(),
    };
  }

  function applyResponsePayload(data) {
    const timingDelays = data && data.timing_delays ? data.timing_delays : {};
    state.rows = Array.isArray(timingDelays.entries) ? timingDelays.entries : [];
    state.domains = Array.isArray(timingDelays.domains) ? timingDelays.domains.slice().sort((a, b) => String(a).localeCompare(String(b))) : [];
    state.valueTypes = Array.isArray(timingDelays.value_types) && timingDelays.value_types.length
      ? timingDelays.value_types.slice()
      : state.valueTypes;
    configPathEl.textContent = timingDelays.config_source || '';
    renderRows();
  }

  async function saveSetting() {
    if (state.saving) return;
    state.saving = true;
    editSaveEl.disabled = true;
    setEditMessage('Saving…', 'muted');

    try {
      const isEdit = Boolean(state.editingOriginalKeyname);
      const payload = collectPayload();
      const data = await api('/admin/config', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      applyResponsePayload(data);
      setStatus(isEdit ? 'Setting updated.' : 'Setting created.', 'ok');
      state.saving = false;
      editSaveEl.disabled = false;
      closeEditModal(true);
      return;
    } catch (err) {
      setEditMessage(String(err), 'err');
    } finally {
      state.saving = false;
      editSaveEl.disabled = false;
    }
  }

  async function load() {
    setStatus('Loading…', 'muted');
    try {
      const data = await api('/admin/config');
      applyResponsePayload(data);
      setStatus('Ready.', 'ok');
    } catch (err) {
      setStatus(String(err), 'err');
    }
  }

  addSettingBtnEl.addEventListener('click', openCreateModal);
  editSaveEl.addEventListener('click', () => { void saveSetting(); });
  editCloseEl.addEventListener('click', closeEditModal);
  editDomainSelectEl.addEventListener('change', syncDomainInputVisibility);
  editOverlayEl.addEventListener('click', (event) => {
    if (event.target === editOverlayEl) closeEditModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !editOverlayEl.classList.contains('hidden')) {
      closeEditModal();
    }
  });

  void load();
})();

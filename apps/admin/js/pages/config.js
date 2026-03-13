(function () {
  'use strict';

  function api(path, init) {
    return window.adminClient.requestJson(path, init);
  }

  function setStatus(text, type) {
    const el = document.getElementById('status');
    el.className = 'status ' + (type || 'muted');
    el.textContent = text || '';
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

  function renderRows(rows) {
    const body = document.getElementById('timingBody');
    body.innerHTML = '';

    if (!Array.isArray(rows) || !rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'empty-state';
      td.textContent = 'No timing configuration rows were returned.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.appendChild(makeCell('Name', row.name || ''));
      tr.appendChild(makeCell('Keyname', makeCode(row.keyname || '')));
      tr.appendChild(makeCell('Value', makeValuePill(row.value)));
      tr.appendChild(makeCell('Description', row.description || ''));
      body.appendChild(tr);
    }
  }

  async function load() {
    setStatus('Loading…', 'muted');
    try {
      const data = await api('/admin/config');
      const timingDelays = data && data.timing_delays ? data.timing_delays : {};
      document.getElementById('configPath').textContent = timingDelays.config_path || '';
      renderRows(timingDelays.entries || []);
      setStatus('Ready.', 'ok');
    } catch (err) {
      setStatus(String(err), 'err');
    }
  }

  void load();
})();

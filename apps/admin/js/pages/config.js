(function () {
  'use strict';

  const apiBase = window.getAdminApiBase();
  document.getElementById('apiBaseLabel').textContent = apiBase;

  function api(path, init) {
    return window.adminClient.requestJson(path, init);
  }

  function setStatus(text, type) {
    const el = document.getElementById('status');
    el.className = 'status ' + (type || 'muted');
    el.textContent = text || '';
  }

  function sourceBadge(svc) {
    const wiredModes = svc.modes.filter((m) => m.wired);
    const mockOnly = wiredModes.length === 1 && wiredModes[0].value === 'mock';
    if (mockOnly) return '<span class="badge badge-stub">mock only - not yet wired</span>';
    if (svc.override_mode) return '<span class="badge badge-override">runtime override</span>';
    if (svc.effective_mode !== 'mock') return '<span class="badge badge-real">live</span>';
    return '<span class="badge badge-env">env default</span>';
  }

  function renderService(svc) {
    const card = document.createElement('div');
    card.className = 'service-card';
    card.dataset.key = svc.key;

    const info = document.createElement('div');
    info.innerHTML = `
      <div class="service-label">${svc.label}</div>
      <div class="service-sub">env: <code>${svc.env_mode}</code></div>
    `;

    const modesEl = document.createElement('div');
    modesEl.className = 'modes';

    for (const mode of svc.modes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = mode.label;
      btn.className = 'mode-btn' + (mode.value === svc.effective_mode ? ' active' : '');
      btn.disabled = !mode.wired || mode.value === svc.effective_mode;
      if (!mode.wired) btn.title = 'Not yet wired - implementation pending';
      btn.addEventListener('click', () => { void patchMode(svc.key, mode.value); });
      modesEl.appendChild(btn);
    }

    const badgeEl = document.createElement('div');
    badgeEl.innerHTML = sourceBadge(svc);

    card.appendChild(info);
    card.appendChild(modesEl);
    card.appendChild(badgeEl);
    return card;
  }

  function renderAll(services) {
    const container = document.getElementById('services');
    container.innerHTML = '';
    for (const svc of services) {
      container.appendChild(renderService(svc));
    }
  }

  async function load() {
    try {
      const data = await api('/admin/config');
      renderAll(data.services);
      setStatus('Ready.', 'ok');
    } catch (err) {
      setStatus(String(err), 'err');
    }
  }

  async function patchMode(key, mode) {
    setStatus('Saving...', 'muted');
    try {
      await api('/admin/config', {
        method: 'POST',
        body: JSON.stringify({ key, mode }),
      });
      await load();
    } catch (err) {
      setStatus(String(err), 'err');
    }
  }

  void load();
})();

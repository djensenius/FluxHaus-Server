import { Router } from 'express';
import { generateCsrfToken } from '../middleware/csrf.middleware';
import { FluxHausServices } from '../services';

const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Calendar Settings — FluxHaus</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro", system-ui, sans-serif;
      background: #0b0c10;
      color: #f5f7fa;
      line-height: 1.45;
    }
    main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { margin: 0 0 6px; font-size: 32px; }
    p.lede { margin: 0 0 28px; color: #a7b0be; }
    .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .panel {
      background: #141821;
      border: 1px solid #232936;
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18);
    }
    h2 { margin: 0 0 14px; font-size: 18px; }
    label { display: block; margin: 0 0 6px; font-size: 13px; color: #b6bfcd; }
    input, select, textarea, button {
      width: 100%;
      border-radius: 10px;
      border: 1px solid #30384a;
      background: #0f131b;
      color: #f5f7fa;
      font: inherit;
      padding: 10px 12px;
    }
    textarea { min-height: 120px; resize: vertical; }
    input[type="checkbox"] { width: auto; margin-right: 8px; }
    .field { margin-bottom: 14px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .row > * { flex: 1; }
    .checkbox { display: flex; align-items: center; font-size: 14px; color: #d4dae3; }
    button {
      background: #3b82f6;
      border-color: #3b82f6;
      cursor: pointer;
      font-weight: 600;
    }
    button.secondary { background: #202736; border-color: #30384a; }
    button.danger { background: #c24141; border-color: #c24141; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .hint { color: #93a0b4; font-size: 13px; margin-top: 8px; }
    .status {
      margin-bottom: 18px;
      padding: 12px 14px;
      border-radius: 12px;
      display: none;
      font-size: 14px;
    }
    .status.show { display: block; }
    .status.success { background: rgba(16, 185, 129, 0.12); color: #b7f7da; border: 1px solid rgba(16,185,129,0.28); }
    .status.error { background: rgba(239, 68, 68, 0.12); color: #ffd0d0; border: 1px solid rgba(239,68,68,0.28); }
    .source-list { display: grid; gap: 14px; }
    .source-card {
      border: 1px solid #293142;
      border-radius: 14px;
      padding: 16px;
      background: #0f131b;
    }
    .source-card h3 { margin: 0 0 6px; font-size: 16px; }
    .source-meta { color: #97a2b5; font-size: 13px; margin-bottom: 12px; }
    .kv { color: #c8d0dc; font-size: 13px; margin-top: 6px; word-break: break-word; }
    .empty { color: #97a2b5; font-style: italic; }
    .hidden { display: none; }
    code { background: #111827; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
<main>
  <h1>Calendar Settings</h1>
  <p class="lede">
    Add your calendar accounts, pick a default calendar for new events,
    and remove sources you no longer use.
  </p>
  <div id="status" class="status"></div>

  <div class="grid">
    <section class="panel">
      <h2>Default Calendar</h2>
      <div class="field">
        <label for="defaultCalendarId">Where new events should go by default</label>
        <select id="defaultCalendarId"></select>
      </div>
      <div class="row">
        <button id="saveDefaultButton">Save Default</button>
        <button id="clearDefaultButton" class="secondary">Clear</button>
      </div>
      <p class="hint">Only writable calendars should be used as your default.</p>
    </section>

    <section class="panel">
      <h2>Add Calendar Source</h2>
      <div class="field">
        <label for="provider">Provider</label>
        <select id="provider">
          <option value="icloud">iCloud</option>
          <option value="m365">Microsoft 365</option>
          <option value="ics">Subscribed ICS</option>
        </select>
      </div>
      <div class="field">
        <label for="displayName">Display Name</label>
        <input id="displayName" placeholder="Personal, Work, School Calendar">
      </div>
      <div class="field checkbox">
        <input id="enabled" type="checkbox" checked>
        <label for="enabled" style="margin:0;">Enabled</label>
      </div>
      <div id="providerFields"></div>
      <button id="addSourceButton">Add Source</button>
      <p class="hint">Secrets are stored encrypted. ICS sources are read-only.</p>
    </section>
  </div>

  <section class="panel" style="margin-top: 20px;">
    <h2>Your Calendar Sources</h2>
    <div id="sourceList" class="source-list"><div class="empty">Loading…</div></div>
  </section>
</main>

<script>
const csrfToken = '%%CSRF_TOKEN%%';
let sources = [];
let calendars = [];
let preferences = { defaultCalendarId: null };

function showStatus(message, type) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = 'status show ' + type;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function api(path, options) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    ...options
  });
  if (!response.ok) {
    let message = response.status + ' ' + response.statusText;
    try {
      const body = await response.json();
      if (body && body.error) message = body.error;
    } catch (_) {}
    throw new Error(message);
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

function renderProviderFields(provider, existing) {
  const root = document.getElementById('providerFields');
  if (provider === 'icloud') {
    root.innerHTML = [
      field('serverUrl', 'Server URL', existing?.config?.serverUrl || 'https://caldav.icloud.com'),
      field('username', 'Apple ID', existing?.config?.username || ''),
      field('password', existing ? 'App-Specific Password (enter to replace)' : 'App-Specific Password', '')
    ].join('');
    return;
  }
  if (provider === 'm365') {
    root.innerHTML = [
      field('tenantId', 'Tenant ID', existing?.config?.tenantId || ''),
      field('clientId', 'Client ID', existing?.config?.clientId || ''),
      field('clientSecret', existing ? 'Client Secret (enter to replace)' : 'Client Secret', ''),
      field('refreshToken', existing ? 'Refresh Token (enter to replace)' : 'Refresh Token', ''),
      field('userId', 'User ID', existing?.config?.userId || 'me')
    ].join('');
    return;
  }
  root.innerHTML = field('url', 'ICS URL', existing?.config?.url || '');
}

function field(id, label, value) {
  return '<div class="field"><label for="' + id + '">' + label + '</label>'
    + '<input id="' + id + '" value="' + escapeHtml(value) + '"></div>';
}

function getProviderConfig(provider, existing) {
  if (provider === 'icloud') {
    const serverUrl = document.getElementById('serverUrl').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    if (existing && !password) return null;
    return { serverUrl, username, password };
  }
  if (provider === 'm365') {
    const tenantId = document.getElementById('tenantId').value.trim();
    const clientId = document.getElementById('clientId').value.trim();
    const clientSecret = document.getElementById('clientSecret').value.trim();
    const refreshToken = document.getElementById('refreshToken').value.trim();
    const userId = document.getElementById('userId').value.trim() || 'me';
    if (existing && !clientSecret && !refreshToken) return null;
    return { tenantId, clientId, clientSecret, refreshToken, userId };
  }
  return { url: document.getElementById('url').value.trim() };
}

function renderDefaultSelect() {
  const select = document.getElementById('defaultCalendarId');
  const options = ['<option value="">No default calendar</option>'];
  calendars.forEach((calendar) => {
    const marker = calendar.writable ? '' : ' (read-only)';
    const selected = preferences.defaultCalendarId === calendar.id ? ' selected' : '';
    options.push('<option value="' + escapeHtml(calendar.id) + '"' + selected + '>'
      + escapeHtml(calendar.name + marker) + '</option>');
  });
  select.innerHTML = options.join('');
}

function renderSources() {
  const root = document.getElementById('sourceList');
  if (!sources.length) {
    root.innerHTML = '<div class="empty">No saved sources yet.</div>';
    return;
  }

  root.innerHTML = sources.map((source) => {
    const config = [];
    Object.keys(source.config || {}).forEach((key) => {
      config.push('<div class="kv"><strong>' + escapeHtml(key) + ':</strong> '
        + escapeHtml(String(source.config[key])) + '</div>');
    });
    return '<div class="source-card">'
      + '<h3>' + escapeHtml(source.displayName) + '</h3>'
      + '<div class="source-meta">' + escapeHtml(source.provider) + ' · '
      + (source.enabled ? 'Enabled' : 'Disabled') + '</div>'
      + config.join('')
      + '<div class="row" style="margin-top:12px;">'
      + '<button class="secondary" onclick="editSource(\\'' + escapeHtml(source.id) + '\\')">Edit</button>'
      + '<button class="danger" onclick="deleteSource(\\'' + escapeHtml(source.id) + '\\')">Delete</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

function resetAddForm() {
  document.getElementById('displayName').value = '';
  document.getElementById('enabled').checked = true;
  document.getElementById('provider').value = 'icloud';
  renderProviderFields('icloud');
  document.getElementById('addSourceButton').textContent = 'Add Source';
  document.getElementById('addSourceButton').dataset.editing = '';
}

async function refreshData() {
  const [sourceData, calendarData, prefData] = await Promise.all([
    api('/calendar-sources'),
    api('/calendar-calendars'),
    api('/preferences')
  ]);
  sources = sourceData || [];
  calendars = calendarData || [];
  preferences = prefData || { defaultCalendarId: null };
  renderSources();
  renderDefaultSelect();
}

window.editSource = function editSource(id) {
  const source = sources.find((item) => item.id === id);
  if (!source) return;
  document.getElementById('provider').value = source.provider;
  document.getElementById('displayName').value = source.displayName;
  document.getElementById('enabled').checked = source.enabled;
  renderProviderFields(source.provider, source);
  document.getElementById('addSourceButton').textContent = 'Save Changes';
  document.getElementById('addSourceButton').dataset.editing = id;
  showStatus('Editing ' + source.displayName + '. Re-enter secrets only if you want to replace them.', 'success');
};

window.deleteSource = async function deleteSource(id) {
  const source = sources.find((item) => item.id === id);
  if (!source || !confirm('Delete "' + source.displayName + '"?')) return;
  try {
    await api('/calendar-sources/' + encodeURIComponent(id), { method: 'DELETE' });
    showStatus('Source deleted.', 'success');
    await refreshData();
    resetAddForm();
  } catch (err) {
    showStatus(err.message, 'error');
  }
};

document.getElementById('provider').addEventListener('change', function () {
  renderProviderFields(this.value);
});

document.getElementById('saveDefaultButton').addEventListener('click', async function () {
  try {
    const value = document.getElementById('defaultCalendarId').value || null;
    await api('/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ defaultCalendarId: value })
    });
    showStatus('Default calendar saved.', 'success');
    await refreshData();
  } catch (err) {
    showStatus(err.message, 'error');
  }
});

document.getElementById('clearDefaultButton').addEventListener('click', async function () {
  try {
    await api('/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ defaultCalendarId: null })
    });
    showStatus('Default calendar cleared.', 'success');
    await refreshData();
  } catch (err) {
    showStatus(err.message, 'error');
  }
});

document.getElementById('addSourceButton').addEventListener('click', async function () {
  const provider = document.getElementById('provider').value;
  const displayName = document.getElementById('displayName').value.trim();
  const enabled = document.getElementById('enabled').checked;
  const editingId = this.dataset.editing;
  try {
    if (!displayName) throw new Error('Display name is required');
    const config = getProviderConfig(provider, editingId ? sources.find((item) => item.id === editingId) : null);
    if (editingId) {
      const payload = { displayName, enabled };
      if (config) payload.config = config;
      await api('/calendar-sources/' + encodeURIComponent(editingId), {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      showStatus('Source updated.', 'success');
    } else {
      if (!config) throw new Error('Provider configuration is required');
      await api('/calendar-sources', {
        method: 'POST',
        body: JSON.stringify({ provider, displayName, enabled, config })
      });
      showStatus('Source added.', 'success');
    }
    await refreshData();
    resetAddForm();
  } catch (err) {
    showStatus(err.message, 'error');
  }
});

resetAddForm();
refreshData().catch((err) => showStatus(err.message, 'error'));
</script>
</body>
</html>`;

export default function createCalendarSettingsRouter(services: FluxHausServices): Router {
  const router = Router();

  router.get('/calendar-settings', (req, res) => {
    if (!req.user?.sub) {
      res.status(403).json({ error: 'OIDC authentication required' });
      return;
    }
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateCsrfToken();
    }
    res.type('html').send(PAGE_HTML.replace('%%CSRF_TOKEN%%', req.session.csrfToken));
  });

  router.get('/calendar-calendars', async (req, res) => {
    if (!req.user?.sub) {
      res.status(403).json({ error: 'OIDC authentication required' });
      return;
    }
    try {
      const calendars = await services.calendar?.listCalendars(req.user.sub) || [];
      res.json(calendars);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  return router;
}

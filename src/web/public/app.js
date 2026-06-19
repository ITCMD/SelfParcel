// SelfParcel front-end. Plain JS, no build step.

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error('Not signed in');
  }
  if (!res.ok && res.status !== 201) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
};

let AUTH_MODE = 'none';

function onUnauthorized() {
  if (AUTH_MODE === 'oidc') {
    window.location.href = `/auth/login?returnTo=${encodeURIComponent(location.pathname)}`;
  } else if (AUTH_MODE === 'local') {
    $('#login-modal').classList.remove('hidden');
  }
}

// Account area plus the admin buttons, driven by the session payload.
function renderAccount(me) {
  AUTH_MODE = me.mode;
  const el = $('#account');
  if (me.mode === 'none' || !me.authenticated) {
    el.classList.add('hidden');
  } else {
    const who = me.user?.username || me.user?.email || me.user?.name || 'Signed in';
    el.innerHTML = `<span class="who">${escapeHtml(who)}</span><a href="/auth/logout">Sign out</a>`;
    el.classList.remove('hidden');
  }
  $('#open-users').classList.toggle('hidden', !me.isAdmin);
  $('#open-providers').classList.toggle('hidden', !me.isAdmin);
}

const STATUS_LABEL = {
  pre_transit: 'Pre-transit',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception',
  unknown: 'Unknown',
};

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function loadCarriers() {
  const carriers = await api('/api/carriers');
  $('#carrier-status').innerHTML = carriers
    .map((c) => {
      // Scrapers work out of the box; API carriers need credentials first.
      const ready = c.kind === 'scraper' || c.configured;
      const cls = ready ? 'ok' : 'warn';
      const note =
        c.kind === 'api' ? (c.configured ? 'API' : 'API · keys needed') : 'scraper';
      return `<span class="chip ${cls}"><span class="dot"></span>${c.name} · ${note}</span>`;
    })
    .join('');
}

async function loadPackages() {
  const archived = $('#show-archived').checked ? '1' : '0';
  const { packages } = await api(`/api/packages?archived=${archived}`);
  const list = $('#package-list');
  $('#empty').classList.toggle('hidden', packages.length > 0);

  list.innerHTML = packages
    .map((p, i) => {
      const status = p.status || 'unknown';
      const checked = p.last_checked_at
        ? `Updated ${fmtDate(p.last_checked_at)}`
        : 'Not checked yet';
      const est = p.est_delivery ? ` · ETA ${fmtDate(p.est_delivery)}` : '';
      const meta = p.last_error
        ? `<span class="err">⚠ ${escapeHtml(p.last_error)}</span>`
        : `${checked}${est} · ${p.eventCount} events`;

      const title = p.label
        ? `<div class="pkg-title">${escapeHtml(p.label)}</div>`
        : `<div class="pkg-title is-tn">${escapeHtml(p.tracking_number)}</div>`;
      // When a label fills the title slot, push the tracking number up to the eyebrow.
      const eyebrowTn = p.label
        ? `<span class="pkg-sep">·</span><span class="pkg-tn">${escapeHtml(p.tracking_number)}</span>`
        : '';
      const sharedTag = !p.isOwner
        ? `<span class="pkg-sep">·</span><span class="pkg-shared">shared by ${escapeHtml(p.sharedBy)}</span>`
        : p.sharedCount
          ? `<span class="pkg-sep">·</span><span class="pkg-shared">shared with ${p.sharedCount}</span>`
          : '';

      const actions = p.isOwner
        ? `<button class="btn small ${p.notify ? '' : 'muted-on'}" data-act="mute" data-id="${p.id}"
              title="${p.notify ? 'Notifications on, click to mute' : 'Muted, click to enable'}">${p.notify ? '🔔' : '🔕'}</button>
            <button class="btn small" data-act="refresh" data-id="${p.id}" title="Refresh now">↻</button>
            ${p.canShare ? `<button class="btn small" data-act="share" data-id="${p.id}" title="Share">👥</button>` : ''}
            <button class="btn small" data-act="archive" data-id="${p.id}">${p.archived ? 'Unarchive' : 'Archive'}</button>
            <button class="btn small danger" data-act="delete" data-id="${p.id}" title="Delete">✕</button>`
        : `<button class="btn small" data-act="refresh" data-id="${p.id}" title="Refresh now">↻</button>
            <button class="btn small danger" data-act="leave" data-id="${p.id}" title="Remove from my list">✕</button>`;

      return `
        <article class="package carrier-${p.carrier}" data-id="${p.id}" data-owner="${p.isOwner ? 1 : 0}" data-can-share="${p.canShare ? 1 : 0}" data-label="${escapeHtml(p.label || p.tracking_number)}" style="animation-delay:${Math.min(i * 35, 280)}ms">
          <div class="pkg-main">
            <div class="pkg-eyebrow">
              <span class="pkg-carrier">${escapeHtml(p.carrierName)}</span>
              ${eyebrowTn}${sharedTag}
            </div>
            ${title}
            <div class="pkg-meta">${meta}</div>
          </div>
          <span class="stamp ${status}"><span class="sdot"></span>${STATUS_LABEL[status] || status}</span>
          <div class="pkg-actions">${actions}</div>
        </article>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

async function openDetail(id) {
  const { package: p, events } = await api(`/api/packages/${id}`);
  $('#modal-body').innerHTML = `
    <h2>${p.label ? escapeHtml(p.label) : escapeHtml(p.tracking_number)}</h2>
    <div class="modal-sub">${escapeHtml(p.carrierName)} · ${escapeHtml(p.tracking_number)}</div>
    <div class="modal-row">
      <span class="stamp ${p.status}"><span class="sdot"></span>${STATUS_LABEL[p.status] || p.status}</span>
      ${p.est_delivery ? `<span class="modal-sub">ETA ${fmtDate(p.est_delivery)}</span>` : ''}
    </div>
    ${p.last_error ? `<div class="error-line">⚠ ${escapeHtml(p.last_error)}</div>` : ''}
    <div class="log-head">Scan history</div>
    ${
      events.length
        ? `<ul class="timeline">${events
            .map(
              (e) => `<li>
                <div class="t-desc">${escapeHtml(e.description)}</div>
                <div class="t-when">${fmtDate(e.timestamp)}</div>
                ${e.location ? `<div class="t-loc">${escapeHtml(e.location)}</div>` : ''}
              </li>`,
            )
            .join('')}</ul>`
        : '<p class="hint">No scan events yet. Check back after the carrier picks it up.</p>'
    }`;
  $('#detail-modal').classList.remove('hidden');
}

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const trackingNumber = $('#tracking-number').value.trim();
  const carrier = $('#carrier').value;
  const label = $('#label').value.trim();
  try {
    await api('/api/packages', {
      method: 'POST',
      body: JSON.stringify({ trackingNumber, carrier: carrier || undefined, label }),
    });
    e.target.reset();
    $('#detect-hint').textContent = '';
    await loadPackages();
    // The first scrape lands a couple seconds later, so re-pull then.
    setTimeout(loadPackages, 2500);
  } catch (err) {
    $('#detect-hint').textContent = err.message;
  }
});

// Auto-detect the carrier while the user types the number.
let detectTimer;
$('#tracking-number').addEventListener('input', (e) => {
  clearTimeout(detectTimer);
  const tn = e.target.value.trim();
  if (!tn || $('#carrier').value) {
    $('#detect-hint').textContent = '';
    return;
  }
  detectTimer = setTimeout(async () => {
    const { carrier } = await api(`/api/detect?trackingNumber=${encodeURIComponent(tn)}`);
    $('#detect-hint').textContent = carrier
      ? `Detected carrier: ${carrier.toUpperCase()}`
      : 'Could not auto-detect, pick a carrier';
  }, 300);
});

$('#package-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    e.stopPropagation();
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === 'share') {
      const card = btn.closest('.package');
      openShare(id, card.dataset.label);
      return;
    }
    btn.disabled = true;
    try {
      if (act === 'refresh') await api(`/api/packages/${id}/refresh`, { method: 'POST' });
      if (act === 'mute') {
        const currentlyOn = btn.textContent.includes('🔔');
        await api(`/api/packages/${id}/notify`, {
          method: 'POST',
          body: JSON.stringify({ notify: !currentlyOn }),
        });
      }
      if (act === 'archive') await api(`/api/packages/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived: true }) });
      if (act === 'leave') {
        if (!confirm('Remove this shared package from your list?')) { btn.disabled = false; return; }
        await api(`/api/packages/${id}/leave`, { method: 'POST' });
      }
      if (act === 'delete') {
        if (!confirm('Delete this package and its history?')) { btn.disabled = false; return; }
        await api(`/api/packages/${id}`, { method: 'DELETE' });
      }
      await loadPackages();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const card = e.target.closest('.package');
  if (card) openDetail(card.dataset.id);
});

// Right-click a package you own to share it.
$('#package-list').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.package');
  if (!card || card.dataset.canShare !== '1') return;
  e.preventDefault();
  openShare(card.dataset.id, card.dataset.label);
});

// ── Sharing ───────────────────────────────────────────────────────────────────
const shareState = { id: null, shared: new Set() };

async function openShare(id, label) {
  shareState.id = id;
  $('#share-sub').textContent = label || '';
  $('#share-search').value = '';
  $('#share-msg').textContent = '';
  $('#share-modal').classList.remove('hidden');
  await refreshShareChips();
  await loadSuggestions('');
}

async function refreshShareChips() {
  const { shares } = await api(`/api/packages/${shareState.id}/shares`);
  shareState.shared = new Set(shares.map((s) => s.userId));
  $('#share-current').innerHTML = shares
    .map(
      (s) =>
        `<span class="share-chip">${escapeHtml(s.username || s.userId)}<button data-unshare="${s.userId}" title="Remove">×</button></span>`,
    )
    .join('');
}

async function loadSuggestions(q) {
  const { users } = await api(`/api/share/candidates?q=${encodeURIComponent(q)}`);
  const rows = users.filter((u) => !shareState.shared.has(u.id));
  $('#share-suggest').innerHTML = rows.length
    ? rows
        .map(
          (u) =>
            `<div class="suggest-row" data-share="${u.id}"><span>${escapeHtml(u.username || u.id)}</span>${u.lastShared ? '<span class="recent">recent</span>' : ''}</div>`,
        )
        .join('')
    : '<p class="hint">No matching users.</p>';
}

let shareSearchTimer;
$('#share-search').addEventListener('input', (e) => {
  clearTimeout(shareSearchTimer);
  const q = e.target.value.trim();
  shareSearchTimer = setTimeout(() => loadSuggestions(q), 200);
});

$('#share-suggest').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-share]');
  if (!row) return;
  try {
    await api(`/api/packages/${shareState.id}/shares`, {
      method: 'POST',
      body: JSON.stringify({ userId: row.dataset.share }),
    });
    await refreshShareChips();
    await loadSuggestions($('#share-search').value.trim());
    loadPackages();
  } catch (err) {
    $('#share-msg').textContent = err.message;
  }
});

$('#share-current').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-unshare]');
  if (!btn) return;
  try {
    await api(`/api/packages/${shareState.id}/shares/${btn.dataset.unshare}`, { method: 'DELETE' });
    await refreshShareChips();
    await loadSuggestions($('#share-search').value.trim());
    loadPackages();
  } catch (err) {
    $('#share-msg').textContent = err.message;
  }
});

$('#share-close').addEventListener('click', () => $('#share-modal').classList.add('hidden'));
$('#share-modal').addEventListener('click', (e) => {
  if (e.target.id === 'share-modal') $('#share-modal').classList.add('hidden');
});

$('#refresh-all').addEventListener('click', async () => {
  const btn = $('#refresh-all');
  btn.disabled = true;
  btn.textContent = '⟳ Refreshing…';
  try {
    const { packages } = await api('/api/packages?archived=0');
    for (const p of packages) {
      await api(`/api/packages/${p.id}/refresh`, { method: 'POST' });
      await loadPackages();
    }
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Refresh all';
  }
});

$('#show-archived').addEventListener('change', loadPackages);
$('#modal-close').addEventListener('click', () => $('#detail-modal').classList.add('hidden'));
$('#detail-modal').addEventListener('click', (e) => {
  if (e.target.id === 'detail-modal') $('#detail-modal').classList.add('hidden');
});

function setVal(sel, v) {
  const el = $(sel);
  if (el) el.value = v || '';
}

async function loadNotify() {
  const data = await api('/api/me/notify');
  $('#trigger-mode').value = data.trigger;
  const c = data.channels;
  setVal('#ch-ntfy-url', c.ntfyUrl);
  setVal('#ch-ntfy-token', c.ntfyToken);
  setVal('#ch-po-token', c.pushoverToken);
  setVal('#ch-po-user', c.pushoverUser);
  setVal('#ch-go-url', c.gotifyUrl);
  setVal('#ch-go-token', c.gotifyToken);
  setVal('#ch-email', c.smtpTo);
  setVal('#ch-wh-url', c.webhookUrl);
  $('#ch-wh-format').value = c.webhookFormat || 'json';
  setVal('#ch-apprise', c.appriseUrls);
  $('#ch-email-note').textContent = data.infra.smtp ? '' : '— server email not set up';
  $('#ch-apprise-note').textContent = data.infra.apprise ? '' : '— server Apprise not set up';
  updatePushUi(data);
}

function collectNotify() {
  return {
    trigger: $('#trigger-mode').value,
    ntfyUrl: $('#ch-ntfy-url').value,
    ntfyToken: $('#ch-ntfy-token').value,
    pushoverToken: $('#ch-po-token').value,
    pushoverUser: $('#ch-po-user').value,
    gotifyUrl: $('#ch-go-url').value,
    gotifyToken: $('#ch-go-token').value,
    smtpTo: $('#ch-email').value,
    webhookUrl: $('#ch-wh-url').value,
    webhookFormat: $('#ch-wh-format').value,
    appriseUrls: $('#ch-apprise').value,
  };
}

function updatePushUi(data) {
  const hint = $('#push-hint');
  const btn = $('#push-toggle');
  if (!data.infra.webpush) {
    hint.textContent =
      'Web Push isn’t configured on the server (set VAPID keys). See the README.';
    btn.disabled = true;
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    hint.textContent = 'This browser doesn’t support push notifications.';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  navigator.serviceWorker.ready
    .then((reg) => reg.pushManager.getSubscription())
    .then((sub) => {
      if (sub) {
        hint.textContent = 'Browser notifications are on for this device.';
        btn.textContent = 'Disable on this device';
        btn.dataset.on = '1';
      } else {
        hint.textContent =
          Notification.permission === 'denied'
            ? 'Notifications are blocked in your browser settings.'
            : 'Get push notifications on this device (works on iOS when installed to the Home Screen).';
        btn.textContent = 'Enable on this device';
        btn.dataset.on = '';
      }
    });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  const { publicKey } = await api('/api/push/key');
  if (!publicKey) throw new Error('Server has no VAPID public key');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permission denied');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 80) }),
  });
}

async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
}

// Per-user carrier API keys (optional; presence = use the API).
async function loadCredentials() {
  const { carriers } = await api('/api/me/credentials');
  $('#creds-list').innerHTML = carriers
    .map((c) => {
      const status = c.hasOwn
        ? '<span class="a-tag admin">using API</span>'
        : '<span class="a-tag">scraping</span>';
      return `<div class="admin-row" data-cred="${c.code}">
        <span class="grow"><span class="a-name">${escapeHtml(c.name)}</span> ${status}</span>
        <input data-cid="${c.code}" placeholder="Client ID" autocomplete="off" />
        <input data-csec="${c.code}" type="password" placeholder="Client secret" autocomplete="off" />
        <select data-cenv="${c.code}">
          <option value="production"${c.env === 'production' ? ' selected' : ''}>production</option>
          <option value="test"${c.env === 'test' ? ' selected' : ''}>test</option>
        </select>
        <span class="a-actions">
          <button class="btn small" data-credact="save" data-code="${c.code}">Save</button>
          ${c.hasOwn ? `<button class="btn small danger" data-credact="clear" data-code="${c.code}">Clear</button>` : ''}
        </span>
      </div>`;
    })
    .join('');
}

$('#creds-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-credact]');
  if (!btn) return;
  const code = btn.dataset.code;
  try {
    if (btn.dataset.credact === 'save') {
      await api(`/api/me/credentials/${code}`, {
        method: 'PUT',
        body: JSON.stringify({
          clientId: $(`[data-cid="${code}"]`).value.trim(),
          clientSecret: $(`[data-csec="${code}"]`).value.trim(),
          env: $(`[data-cenv="${code}"]`).value,
        }),
      });
    } else if (btn.dataset.credact === 'clear') {
      await api(`/api/me/credentials/${code}`, { method: 'DELETE' });
    }
    await loadCredentials();
  } catch (err) {
    alert(err.message);
  }
});

$('#open-settings').addEventListener('click', async () => {
  $('#settings-modal').classList.remove('hidden');
  $('#notify-msg').textContent = '';
  await loadCredentials();
  await loadNotify();
});
$('#settings-close').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
$('#settings-modal').addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') $('#settings-modal').classList.add('hidden');
});

$('#trigger-mode').addEventListener('change', async (e) => {
  await api('/api/me/notify', { method: 'PUT', body: JSON.stringify({ trigger: e.target.value }) });
});

$('#notify-save').addEventListener('click', async () => {
  const msg = $('#notify-msg');
  try {
    await api('/api/me/notify', { method: 'PUT', body: JSON.stringify(collectNotify()) });
    msg.textContent = 'Saved.';
    await loadNotify();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#push-toggle').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    if (btn.dataset.on) await disablePush();
    else await enablePush();
    await loadNotify();
  } catch (err) {
    $('#push-hint').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#test-notify').addEventListener('click', async () => {
  const out = $('#notify-msg');
  out.textContent = 'Sending…';
  try {
    const r = await api('/api/me/notify/test', { method: 'POST' });
    const sent = r.sent?.length || 0;
    const failed = r.failed?.length || 0;
    out.textContent = sent
      ? `Sent to ${sent} channel${sent === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`
      : failed
        ? `All ${failed} channel(s) failed, check server logs.`
        : 'No channels configured yet.';
  } catch (err) {
    out.textContent = err.message;
  }
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// Login gate, used in local auth mode.
async function showLogin() {
  const cfg = await fetch('/auth/config').then((r) => r.json());
  const canRegister = cfg.openRegistration;
  const first = !cfg.hasUsers;
  $('#register-head').textContent = first ? 'Create the first account (admin)' : 'Create account';
  // First-run: there are no users yet, so open straight on register.
  $('#login-pane').classList.toggle('hidden', first);
  $('#register-pane').classList.toggle('hidden', !first);
  $('#login-switch').innerHTML = canRegister ? 'Need an account? <a id="to-register">Register</a>' : '';
  $('#register-switch').innerHTML = '<a id="to-login">Back to sign in</a>';
  $('#login-modal').classList.remove('hidden');

  const toReg = $('#to-register');
  if (toReg)
    toReg.onclick = () => {
      $('#login-pane').classList.add('hidden');
      $('#register-pane').classList.remove('hidden');
    };
  $('#to-login').onclick = () => {
    $('#register-pane').classList.add('hidden');
    $('#login-pane').classList.remove('hidden');
  };
}

function showLoginError(msg) {
  const el = $('#login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/auth/local-login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#login-user').value, password: $('#login-pass').value }),
    });
    location.reload();
  } catch (err) {
    showLoginError(err.message);
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#reg-user').value,
        email: $('#reg-email').value || undefined,
        password: $('#reg-pass').value,
      }),
    });
    location.reload();
  } catch (err) {
    showLoginError(err.message);
  }
});

async function loadUsers() {
  const [{ users, mode }, reg] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/registration'),
  ]);
  $('#reg-toggle').checked = reg.open;
  // OIDC provisions users on login, so hide the manual create form there.
  $('#create-user-box').classList.toggle('hidden', mode === 'oidc');

  $('#users-list').innerHTML = users
    .map((u) => {
      const tags = [
        `<span class="a-tag ${u.role === 'admin' ? 'admin' : ''}">${u.role}</span>`,
        u.disabled ? '<span class="a-tag off">disabled</span>' : '',
        `<span class="a-tag">${u.source}</span>`,
      ].join('');
      const roleBtn =
        u.role === 'admin'
          ? `<button class="btn small" data-uact="demote" data-id="${u.id}">Make user</button>`
          : `<button class="btn small" data-uact="promote" data-id="${u.id}">Make admin</button>`;
      const disBtn = u.disabled
        ? `<button class="btn small" data-uact="enable" data-id="${u.id}">Enable</button>`
        : `<button class="btn small" data-uact="disable" data-id="${u.id}">Disable</button>`;
      const pwBtn =
        u.source === 'local'
          ? `<button class="btn small" data-uact="password" data-id="${u.id}">Reset pw</button>`
          : '';
      return `<div class="admin-row">
        <span class="grow"><span class="a-name">${escapeHtml(u.username || u.email || u.id)}</span></span>
        ${tags}
        <span class="a-actions">${roleBtn}${disBtn}${pwBtn}
          <button class="btn small danger" data-uact="delete" data-id="${u.id}">✕</button>
        </span>
      </div>`;
    })
    .join('');
}

$('#users-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-uact]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.uact;
  const msg = $('#users-msg');
  msg.textContent = '';
  try {
    if (act === 'promote') await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
    if (act === 'demote') await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role: 'user' }) });
    if (act === 'disable') await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled: true }) });
    if (act === 'enable') await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled: false }) });
    if (act === 'password') {
      const pw = prompt('New password (min 8 chars):');
      if (!pw) return;
      await api(`/api/admin/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) });
      msg.textContent = 'Password updated.';
    }
    if (act === 'delete') {
      if (!confirm('Delete this user?')) return;
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
    }
    await loadUsers();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#create-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#users-msg');
  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#cu-user').value,
        password: $('#cu-pass').value,
        role: $('#cu-role').value,
      }),
    });
    e.target.reset();
    await loadUsers();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#reg-toggle').addEventListener('change', async (e) => {
  await api('/api/admin/registration', { method: 'PUT', body: JSON.stringify({ open: e.target.checked }) });
});

$('#open-users').addEventListener('click', async () => {
  $('#users-modal').classList.remove('hidden');
  $('#users-msg').textContent = '';
  await loadUsers();
});
$('#users-close').addEventListener('click', () => $('#users-modal').classList.add('hidden'));

async function loadProviders() {
  const [{ modules }, carriers] = await Promise.all([
    api('/api/admin/modules'),
    api('/api/carriers'),
  ]);
  const native = carriers.filter((c) => c.source === 'native');
  const nativeRows = native
    .map(
      (c) => `<div class="admin-row">
        <span class="grow"><span class="a-name">${escapeHtml(c.name)}</span></span>
        <span class="a-tag">native ${c.kind}</span>
        <span class="a-tag ${c.configured ? '' : 'off'}">${c.configured ? 'ready' : 'needs keys'}</span>
      </div>`,
    )
    .join('');
  const moduleRows = modules
    .map((m) => {
      const builtinTag = m.builtin ? '<span class="a-tag">built-in</span>' : '';
      const enableBtn = `<button class="btn small ${m.enabled ? '' : 'muted-on'}" data-pact="toggle" data-code="${m.code}" data-on="${m.enabled ? 1 : 0}">${m.enabled ? 'Enabled' : 'Disabled'}</button>`;
      const resetBtn = m.builtin ? `<button class="btn small" data-pact="reset" data-code="${m.code}">Reset</button>` : '';
      const delBtn = m.builtin ? '' : `<button class="btn small danger" data-pact="delete" data-code="${m.code}">✕</button>`;
      return `<div class="admin-row">
        <span class="grow"><span class="a-name">${escapeHtml(m.name)}</span> <span class="a-tag">${m.kind}</span> ${builtinTag}</span>
        <span class="a-actions">
          ${enableBtn}
          <button class="btn small" data-pact="edit" data-code="${m.code}">Edit</button>
          ${resetBtn}${delBtn}
        </span>
      </div>`;
    })
    .join('');
  $('#providers-list').innerHTML = nativeRows + moduleRows;
}

$('#providers-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-pact]');
  if (!btn) return;
  const code = btn.dataset.code;
  const act = btn.dataset.pact;
  const msg = $('#providers-msg');
  msg.textContent = '';
  try {
    if (act === 'toggle') {
      await api(`/api/admin/modules/${code}/enable`, { method: 'POST', body: JSON.stringify({ enabled: btn.dataset.on !== '1' }) });
      await loadProviders();
    }
    if (act === 'reset') {
      await api(`/api/admin/modules/${code}/reset`, { method: 'POST' });
      await loadProviders();
      msg.textContent = `${code} reset to default.`;
    }
    if (act === 'delete') {
      if (!confirm(`Delete provider "${code}"?`)) return;
      await api(`/api/admin/modules/${code}`, { method: 'DELETE' });
      await loadProviders();
    }
    if (act === 'edit') openModuleEditor(code);
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#install-url-btn').addEventListener('click', async () => {
  const msg = $('#providers-msg');
  msg.textContent = 'Fetching…';
  try {
    const r = await api('/api/admin/modules/install-url', {
      method: 'POST',
      body: JSON.stringify({ url: $('#install-url').value.trim() }),
    });
    $('#install-url').value = '';
    await loadProviders();
    msg.textContent = `Installed "${r.code}" (disabled). Review and enable it.`;
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#install-json-btn').addEventListener('click', async () => {
  const msg = $('#providers-msg');
  try {
    const module = JSON.parse($('#install-json').value);
    const r = await api('/api/admin/modules', { method: 'POST', body: JSON.stringify({ module }) });
    $('#install-json').value = '';
    await loadProviders();
    msg.textContent = `Installed "${r.code}".`;
  } catch (err) {
    msg.textContent = err.message.startsWith('Unexpected') ? 'That is not valid JSON.' : err.message;
  }
});

$('#open-providers').addEventListener('click', async () => {
  $('#providers-modal').classList.remove('hidden');
  $('#providers-msg').textContent = '';
  await loadProviders();
});
$('#providers-close').addEventListener('click', () => $('#providers-modal').classList.add('hidden'));

let editingCode = null;
async function openModuleEditor(code) {
  editingCode = code;
  const data = await api(`/api/admin/modules/${code}`);
  $('#module-edit-title').textContent = `Edit: ${data.name}`;
  $('#module-edit-json').value = JSON.stringify(data.module, null, 2);
  $('#module-edit-msg').textContent = '';
  $('#module-test-out').innerHTML = '';
  $('#module-reset-btn').classList.toggle('hidden', !data.builtin);
  $('#module-edit-modal').classList.remove('hidden');
}

$('#module-save-btn').addEventListener('click', async () => {
  const msg = $('#module-edit-msg');
  try {
    const module = JSON.parse($('#module-edit-json').value);
    await api(`/api/admin/modules/${editingCode}`, { method: 'PUT', body: JSON.stringify({ module }) });
    msg.textContent = 'Saved.';
    await loadProviders();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#module-test-btn').addEventListener('click', async () => {
  const tn = $('#module-test-tn').value.trim();
  const out = $('#module-test-out');
  if (!tn) return;
  out.innerHTML = '<p class="hint">Testing…</p>';
  // Persist the edits first, otherwise the test would run the old version.
  try {
    const module = JSON.parse($('#module-edit-json').value);
    await api(`/api/admin/modules/${editingCode}`, { method: 'PUT', body: JSON.stringify({ module }) });
  } catch (err) {
    out.innerHTML = `<p class="error-line">${escapeHtml(err.message)}</p>`;
    return;
  }
  const { debug } = await api(`/api/admin/modules/${editingCode}/test`, { method: 'POST', body: JSON.stringify({ trackingNumber: tn }) });
  const ev = debug.events || [];

  if (debug.ok) {
    out.innerHTML = `<div class="log-head">Parsed ${ev.length} event(s) via ${debug.source} · status: ${debug.status}</div>
      <ul class="timeline">${ev
        .slice(0, 8)
        .map((e) => `<li><div class="t-desc">${escapeHtml(e.description)}</div><div class="t-when">${fmtDate(e.timestamp)}</div>${e.location ? `<div class="t-loc">${escapeHtml(e.location)}</div>` : ''}</li>`)
        .join('')}</ul>`;
    return;
  }

  // Failed: show what was actually fetched so the cause is obvious.
  const bits = [];
  if (debug.blocked) bits.push('<span class="a-tag off">looks blocked</span>');
  if (debug.httpStatus) bits.push(`HTTP ${debug.httpStatus}`);
  bits.push(`source: ${debug.source}`);
  if (debug.htmlLength != null) bits.push(`${debug.htmlLength} bytes`);
  out.innerHTML = `
    <div class="log-head">No events parsed</div>
    <p class="hint">${bits.join(' · ')}</p>
    ${debug.title ? `<p class="hint">Page title: <strong>${escapeHtml(debug.title)}</strong></p>` : ''}
    ${debug.notes?.length ? `<p class="hint">${debug.notes.map(escapeHtml).join('<br>')}</p>` : ''}
    ${debug.sample ? `<div class="code-area" style="min-height:80px;white-space:pre-wrap">${escapeHtml(debug.sample)}</div>` : ''}`;
});

$('#module-reset-btn').addEventListener('click', async () => {
  if (!confirm('Reset this built-in module to its default?')) return;
  await api(`/api/admin/modules/${editingCode}/reset`, { method: 'POST' });
  await openModuleEditor(editingCode);
  await loadProviders();
});

$('#module-edit-close').addEventListener('click', () => $('#module-edit-modal').classList.add('hidden'));

async function boot() {
  let me;
  try {
    me = await fetch('/auth/me').then((r) => r.json());
  } catch {
    me = { mode: 'none', authenticated: false };
  }
  AUTH_MODE = me.mode;

  if (me.mode !== 'none' && !me.authenticated) {
    if (me.mode === 'oidc') {
      window.location.href = '/auth/login?returnTo=/';
      return;
    }
    await showLogin();
    return;
  }

  renderAccount(me);
  registerServiceWorker();
  loadCarriers();
  loadPackages();
  setInterval(loadPackages, 60_000);
}

boot();

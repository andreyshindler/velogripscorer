'use strict';

/* global t, setLang, fmtDate, LANG */

// ---------- state & helpers ----------

// Base path when hosted under a URL prefix (e.g. /veloscorer): derived from
// this script's own URL so it works at any mount point.
const BASE = new URL('.', document.currentScript.src).pathname.replace(/\/$/, '');

const state = {
  token: localStorage.getItem('token') || null,
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  sse: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('error_generic'));
  return data;
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = isError ? 'var(--danger)' : 'var(--text)';
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  if (token) {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
  } else {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }
  renderChrome();
}

function avatar(url, name) {
  return url
    ? `<img class="avatar" src="${esc(url)}" alt="">`
    : `<span class="avatar" aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;font-weight:700">${esc((name || '?')[0].toUpperCase())}</span>`;
}

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

// ---------- chrome (topbar, auth, bell) ----------

function renderChrome() {
  const authArea = document.getElementById('auth-area');
  document.getElementById('nav-startlists').hidden = !state.user;
  document.getElementById('nav-admin').hidden = !(state.user && state.user.role === 'admin');
  document.getElementById('bell').hidden = !state.user;
  if (state.user) {
    authArea.innerHTML = `
      <a href="#/profile/${state.user.id}" style="font-weight:600">${avatar(state.user.avatar_url, state.user.name)} ${esc(state.user.name)}</a>
      <button class="ghost" id="logout-btn">${t('logout')}</button>`;
    document.getElementById('logout-btn').onclick = () => { setSession(null, null); location.hash = '#/'; };
    pollNotifications();
  } else {
    authArea.innerHTML = `<a class="btn small" href="#/login">${t('login')}</a>`;
  }
}

let notifTimer = null;
async function pollNotifications() {
  clearTimeout(notifTimer);
  if (!state.user) return;
  try {
    const { notifications, unread } = await api('/notifications');
    const count = document.getElementById('bell-count');
    count.hidden = unread === 0;
    count.textContent = unread;
    const menu = document.getElementById('bell-menu');
    menu.innerHTML = notifications.length
      ? `<button class="btn small secondary" id="mark-read" style="margin:4px">${t('mark_all_read')}</button>` +
        notifications.map((n) => `
          <div class="notif ${n.read ? '' : 'unread'}">
            ${n.data.contest_id ? `<a href="#/contest/${n.data.contest_id}">${esc(n.message)}</a>` : esc(n.message)}
            <time>${fmtDate(n.created_at)}</time>
          </div>`).join('')
      : `<div class="notif">${t('no_notifications')}</div>`;
    const markBtn = document.getElementById('mark-read');
    if (markBtn) markBtn.onclick = async () => { await api('/notifications/read', { method: 'POST', body: {} }); pollNotifications(); };
  } catch { /* not fatal */ }
  notifTimer = setTimeout(pollNotifications, 30000);
}

document.getElementById('bell').addEventListener('click', () => {
  const menu = document.getElementById('bell-menu');
  const bell = document.getElementById('bell');
  menu.hidden = !menu.hidden;
  bell.setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.bell-wrap')) document.getElementById('bell-menu').hidden = true;
});

document.getElementById('lang-toggle').addEventListener('click', () => {
  setLang(LANG === 'en' ? 'he' : 'en');
  renderChrome();
  route();
});

// ---------- router ----------

const main = document.getElementById('main');

function closeSse() {
  if (state.sse) { state.sse.close(); state.sse = null; }
}

async function route() {
  closeSse();
  const hash = location.hash.slice(1) || '/';
  const [, page, arg, sub] = hash.match(/^\/([^/]*)\/?([^/]*)\/?([^/]*)/) || [];
  try {
    if (!page) return viewHome();
    if (page === 'login') return viewLogin();
    if (page === 'finished') return viewFinishedRaces();
    if (page === 'startlists') return viewStartLists();
    if (page === 'results') return viewPublicResults(Number(arg), sub || 'winners');
    if (page === 'contest') return viewContest(Number(arg), sub || '');
    if (page === 'profile') return viewProfile(Number(arg));
    if (page === 'admin') return viewAdmin(arg || 'reports');
    viewHome();
  } catch (err) {
    main.innerHTML = `<div class="card">${esc(err.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------- home ----------

async function viewHome() {
  main.innerHTML = `
    <div class="hero">
      <h1>🏁 ${t('hero_title')}</h1>
      <p>${t('hero_sub')}</p>
    </div>
    <form class="searchbar" id="search-form" role="search">
      <input type="search" id="q" placeholder="${t('search_placeholder')}" aria-label="${t('search_placeholder')}">
      <button class="btn" type="submit">🔍</button>
    </form>
    <h2>${t('races')}</h2>
    <div class="grid" id="contest-list"></div>`;

  document.getElementById('search-form').onsubmit = (e) => { e.preventDefault(); loadContests(); };
  loadContests();
}

async function loadContests() {
  const q = document.getElementById('q').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  const { contests } = await api(`/contests?${params}`);
  document.getElementById('contest-list').innerHTML = contests.length
    ? contests.map(contestCard).join('')
    : `<p class="muted">${t('no_contests')}</p>`;
}

function contestCard(c) {
  const started = new Date(c.start_at) <= new Date();
  const statusPill = c.status === 'finished'
    ? `<span class="pill finished">${t('status_finished')}</span>`
    : started ? `<span class="pill live">● ${t('hero_live')}</span>` : `<span class="pill">${t('live_upcoming')}</span>`;
  return `
    <a class="card contest-card" href="#/contest/${c.id}" style="color:inherit;text-decoration:none">
      <div>
        <span class="pill">🏁 ${esc(c.sport) || t('race_kind')}</span>
        ${statusPill}
      </div>
      <h3>${esc(c.title)}</h3>
      <div class="meta">
        ${c.location ? `<span>📍 ${esc(c.location)}</span>` : ''}
        <span>🗓 ${fmtDate(c.start_at)}</span>
        <span>👤 ${esc(c.organizer_name || '')}</span>
      </div>
      <div>${(c.tags || []).slice(0, 4).map((tag) => `<span class="pill tag">#${esc(tag)}</span>`).join(' ')}</div>
    </a>`;
}

// ---------- finished races (public results directory) ----------

async function viewFinishedRaces() {
  main.innerHTML = `<h1>🏁 ${t('nav_finished')}</h1><div class="grid" id="finished-list"></div>`;
  const { contests } = await api('/contests?status=finished');
  const races = (contests || []).filter((c) => c.kind === 'race');
  document.getElementById('finished-list').innerHTML = races.length
    ? races.map(finishedCard).join('')
    : `<p class="muted">${t('no_finished_races')}</p>`;
}

function finishedCard(c) {
  return `
    <a class="card contest-card" href="#/results/${c.id}" style="color:inherit;text-decoration:none">
      <div>
        <span class="pill">🏁 ${esc(c.sport) || t('race_kind')}</span>
        <span class="pill finished">${t('status_finished')}</span>
      </div>
      <h3>${esc(c.title)}</h3>
      <div class="meta">
        ${c.location ? `<span>📍 ${esc(c.location)}</span>` : ''}
        <span>🗓 ${fmtDate(c.start_at)}</span>
      </div>
      <div class="pill tag">${t('view_results_link')} ❯</div>
    </a>`;
}

// ---------- auth ----------

function viewLogin() {
  main.innerHTML = `
    <div class="card form-narrow">
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected="true" id="tab-login">${t('login')}</button>
        <button role="tab" aria-selected="false" id="tab-register">${t('register')}</button>
      </div>
      <form id="auth-form">
        <div id="name-field" hidden>
          <label for="f-name">${t('display_name')}</label>
          <input id="f-name" autocomplete="name">
        </div>
        <label for="f-email">${t('email')}</label>
        <input id="f-email" type="email" required autocomplete="email">
        <label for="f-password">${t('password')}</label>
        <input id="f-password" type="password" required minlength="8" autocomplete="current-password">
        <button class="btn mt" type="submit" id="auth-submit">${t('login')}</button>
      </form>
    </div>`;
  let mode = 'login';
  const setMode = (m) => {
    mode = m;
    document.getElementById('name-field').hidden = m === 'login';
    document.getElementById('auth-submit').textContent = t(m);
    document.getElementById('tab-login').setAttribute('aria-selected', String(m === 'login'));
    document.getElementById('tab-register').setAttribute('aria-selected', String(m === 'register'));
  };
  document.getElementById('tab-login').onclick = () => setMode('login');
  document.getElementById('tab-register').onclick = () => setMode('register');
  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = {
        email: document.getElementById('f-email').value,
        password: document.getElementById('f-password').value,
      };
      if (mode === 'register') body.name = document.getElementById('f-name').value;
      const data = await api(`/auth/${mode}`, { method: 'POST', body });
      setSession(data.token, data.user);
      location.hash = '#/';
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- my start lists ----------

// Resize an image file down to a JPEG data URL so it fits comfortably in the
// contest record (and the JSON body limit) without a separate upload endpoint.
function fileToResizedDataURL(file, maxDim = 1000, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return resolve('');
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}

const SPORT_OPTIONS = [
  'Running', 'MTB — Cross-country (XCO)', 'MTB — Marathon (XCM)', 'MTB — Enduro',
  'MTB — Downhill', 'MTB — Trail', 'Gravel', 'Road cycling', 'Duathlon', 'Triathlon',
];

// Load Leaflet on demand (only when the organizer opens the map picker).
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error('leaflet failed to load'));
    document.head.appendChild(js);
  });
}

// Modal map: click to drop a pin, reverse-geocode to a place name via Nominatim.
async function pickLocationOnMap(onPick) {
  let L;
  try { L = await loadLeaflet(); } catch { toast(t('map_unavailable'), true); return; }
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `<div style="background:#fff;border-radius:10px;max-width:560px;width:100%;overflow:hidden">
    <div id="pickmap" style="height:360px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;padding:10px">
      <button class="btn small secondary" id="map-cancel">${t('cancel')}</button>
      <button class="btn small" id="map-set">${t('set_location')}</button>
    </div></div>`;
  document.body.appendChild(overlay);
  const map = L.map(overlay.querySelector('#pickmap')).setView([31.61, 34.76], 12); // Kiryat Gat
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }).addTo(map);
  let marker = null, coords = null;
  map.on('click', (e) => {
    coords = e.latlng;
    if (marker) marker.setLatLng(e.latlng); else marker = L.marker(e.latlng).addTo(map);
  });
  setTimeout(() => map.invalidateSize(), 200);
  const close = () => { map.remove(); overlay.remove(); };
  overlay.querySelector('#map-cancel').onclick = close;
  overlay.querySelector('#map-set').onclick = async () => {
    if (!coords) { close(); return; }
    let name = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=12&lat=${coords.lat}&lon=${coords.lng}`, { headers: { Accept: 'application/json' } });
      const j = await r.json();
      if (j && j.display_name) name = j.display_name.split(',').slice(0, 3).map((s) => s.trim()).join(', ');
    } catch { /* keep the lat,lng fallback */ }
    onPick(name);
    close();
  };
}

async function viewStartLists() {
  if (!state.user) { location.hash = '#/login'; return; }
  main.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <h1 style="margin:0">${t('my_startlists')}</h1>
      <button class="btn" id="add-list">➕ ${t('add_new_list')}</button>
    </div>

    <div class="card mt" id="new-list-card" hidden>
      <h3 style="margin-top:0">${t('add_new_list')}</h3>
      <form id="new-list-form">
        <label for="l-title">${t('contest_title')}</label>
        <input id="l-title" required maxlength="120">
        <div class="row2">
          <div><label for="l-date">${t('start_date')}</label><input id="l-date" type="date" required></div>
          <div><label for="l-sport">${t('sport')}</label>
            <select id="l-sport">${SPORT_OPTIONS.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select></div>
        </div>
        <label for="l-organizer">${t('organizer')}</label>
        <input id="l-organizer" value="VeloGrip" maxlength="80">
        <label for="l-location">${t('location')}</label>
        <div style="display:flex;gap:8px">
          <input id="l-location" placeholder="${t('location_hint')}" style="flex:1">
          <button type="button" class="btn small secondary" id="l-map" style="white-space:nowrap">📍 ${t('pick_on_map')}</button>
        </div>
        <label for="l-file">${t('startlist_file_label')}</label>
        <input id="l-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
        <label for="l-photo">${t('race_photo')}</label>
        <input id="l-photo" type="file" accept="image/*">
        <div class="mt"><button class="btn" type="submit">${t('create')}</button></div>
      </form>
    </div>

    <p class="muted" id="races-found"></p>
    <div class="card" style="overflow-x:auto;padding:0">
      <table class="board" style="margin:0">
        <thead><tr>
          <th>${t('contest_title')}</th><th>${t('racers_count')}</th><th>${t('start_date')}</th>
          <th>${t('location')}</th><th>${t('sport')}</th><th></th>
        </tr></thead>
        <tbody id="lists-body"></tbody>
      </table>
    </div>`;

  const addBtn = document.getElementById('add-list');
  const card = document.getElementById('new-list-card');
  addBtn.onclick = () => { card.hidden = !card.hidden; if (!card.hidden) document.getElementById('l-title').focus(); };

  document.getElementById('l-map').onclick = () =>
    pickLocationOnMap((name) => { document.getElementById('l-location').value = name; });

  // Default the race title to the uploaded file's name (minus extension).
  document.getElementById('l-file').onchange = (e) => {
    const f = e.target.files[0];
    const titleEl = document.getElementById('l-title');
    if (f && !titleEl.value.trim()) {
      titleEl.value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    }
  };

  document.getElementById('new-list-form').onsubmit = async (e) => {
    e.preventDefault();
    const day = document.getElementById('l-date').value;
    const body = {
      kind: 'race',
      title: document.getElementById('l-title').value,
      sport: document.getElementById('l-sport').value,
      organizer_name: document.getElementById('l-organizer').value,
      location: document.getElementById('l-location').value,
      category: 'other',
      start_at: new Date(day + 'T00:00').toISOString(),
      end_at: new Date(day + 'T23:59').toISOString(),
    };
    try {
      const photoFile = document.getElementById('l-photo').files[0];
      if (photoFile) body.photo_url = await fileToResizedDataURL(photoFile);
      const contest = await api('/contests', { method: 'POST', body });
      const file = document.getElementById('l-file').files[0];
      if (file) {
        const form = new FormData();
        form.set('file', file);
        const result = await api(`/contests/${contest.id}/startlist-file`, { method: 'POST', form });
        toast(t('import_done', { n: result.imported, s: result.skipped })
          + (result.errors.length ? ' — ' + result.errors[0] : ''), result.errors.length > 0);
      }
      location.hash = `#/contest/${contest.id}/manage`;
    } catch (err) { toast(err.message, true); }
  };

  await loadStartLists();
}

async function loadStartLists() {
  const { races } = await api('/my/races');
  document.getElementById('races-found').textContent = t('races_found', { n: races.length });
  const body = document.getElementById('lists-body');
  body.innerHTML = races.map((r) => `
    <tr>
      <td><a href="#/contest/${r.id}/startlist" style="color:var(--ok);font-weight:600">${esc(r.title)}</a></td>
      <td>${r.racer_count}</td>
      <td>${new Date(r.start_at).toLocaleDateString(LANG === 'he' ? 'he-IL' : 'en-US',
        { year: 'numeric', month: 'short', day: 'numeric' })}</td>
      <td>${esc(r.location || '')}</td>
      <td>${esc(r.sport || '')}</td>
      <td><button class="ghost list-del" data-id="${r.id}" data-title="${esc(r.title)}" aria-label="${t('delete')}">✕</button></td>
    </tr>`).join('') || `<tr><td colspan="6" class="muted">${t('no_contests')}</td></tr>`;
  body.querySelectorAll('.list-del').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`${t('delete_race')}: ${btn.dataset.title}?`)) return;
      try {
        await api(`/contests/${btn.dataset.id}`, { method: 'DELETE' });
        toast('✓');
        loadStartLists();
      } catch (err) { toast(err.message, true); }
    };
  });
}

// ---------- contest page ----------

let renderGeneration = 0;

async function viewContest(id, tab) {
  const generation = ++renderGeneration;
  const c = await api(`/contests/${id}`);
  if (generation !== renderGeneration) return; // a newer render superseded this one
  const tabs = ['results', 'startlist', 'details'];
  if (c.is_organizer) tabs.push('manage');
  if (!tabs.includes(tab)) tab = 'results';
  main.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:start;flex-wrap:wrap">
      <div>
        <h1 style="margin:0 0 4px">${esc(c.title)}</h1>
        <div class="muted">
          <span class="pill">🏁 ${esc(c.sport) || t('race_kind')}</span>
          ${c.location ? `<span class="pill tag">📍 ${esc(c.location)}</span>` : ''}
          <span class="pill ${c.status === 'finished' ? 'finished' : 'live'}">
            ${c.status === 'finished' ? t('status_finished') : '● ' + t('hero_live')}
          </span>
          ${t('by')} <a href="#/profile/${c.organizer.id}">${esc(c.organizer.name)}</a>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${state.user ? `<button class="btn small secondary" id="follow-btn">${c.is_following ? t('unfollow') : t('follow')}</button>` : ''}
      </div>
    </div>
    <div class="tabs" role="tablist">
      ${tabs.map((name) => `<button role="tab" aria-selected="${name === tab}" data-tab="${name}">${t('tab_' + name)}</button>`).join('')}
    </div>
    <div id="tab-content"></div>`;

  main.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => { location.hash = `#/contest/${id}/${btn.dataset.tab}`; };
  });
  const followBtn = document.getElementById('follow-btn');
  if (followBtn) followBtn.onclick = async () => {
    await api(`/contests/${id}/follow`, { method: c.is_following ? 'DELETE' : 'POST' });
    viewContest(id, tab);
  };
  const box = document.getElementById('tab-content');
  if (tab === 'results') renderRaceResults(box, c);
  else if (tab === 'startlist') renderStartlist(box, c);
  else if (tab === 'details') renderDetails(box, c);
  else if (tab === 'manage') renderManage(box, c);
}

function renderDetails(box, c) {
  box.innerHTML = `
    <div class="detail-grid">
      <div class="card">
        <p style="white-space:pre-wrap">${esc(c.description) || '<span class="muted">—</span>'}</p>
        <div>${(c.tags || []).map((tag) => `<span class="pill tag">#${esc(tag)}</span>`).join(' ')}</div>
        ${c.criteria.length ? `<h3>${t('criteria')}</h3>
        <ul class="stat-list">
          ${c.criteria.map((cr) => `<li><span>${esc(cr.name)}</span><strong>${cr.weight}% ${t('weight')}</strong></li>`).join('')}
        </ul>` : ''}
        ${c.prizes.length ? `<h3>${t('prizes')}</h3><ul class="stat-list">
          ${c.prizes.map((p) => `<li><span>${MEDALS[p.rank] || '🎖'} ${t('prize_rank')} ${p.rank}</span><strong>${esc(p.name)}</strong></li>`).join('')}</ul>` : ''}
      </div>
      <div class="card">
        <ul class="stat-list">
          ${c.sport ? `<li><span>${t('sport')}</span><strong>${esc(c.sport)}</strong></li>` : ''}
          ${c.location ? `<li><span>${t('location')}</span><strong>${esc(c.location)}</strong></li>` : ''}
          <li><span>${t('starts')}</span><strong>${fmtDate(c.start_at)}</strong></li>
          <li><span>${t('ends')}</span><strong>${fmtDate(c.end_at)}</strong></li>
          <li><span>${t('visibility')}</span><strong>${t(c.visibility)}</strong></li>
          ${c.invite_code ? `<li><span>${t('invite_code')}</span><strong><code>${esc(c.invite_code)}</code></strong></li>` : ''}
        </ul>

      </div>
    </div>`;
}

// ---------- public race views: live results & start list ----------

const RACE_STATUS_LABEL = () => ({
  finished: t('status_finished_r'), on_course: t('status_on_course'),
  not_started: t('status_not_started'), DNS: 'DNS', DNF: 'DNF', DSQ: 'DSQ',
});

async function renderRaceResults(box, c) {
  const generation = renderGeneration;
  const data = await api(`/contests/${c.id}/race-results`);
  if (generation !== renderGeneration) return;
  const categories = [...new Set(data.results.map((r) => r.category).filter(Boolean))];

  box.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${t('race_results')} <span class="live-indicator">● ${t('live')}</span></h3>
        <div style="display:flex;gap:8px;align-items:center">
          ${categories.length ? `<select id="cat-filter" aria-label="${t('category')}">
            <option value="">${t('all_cats')}</option>
            ${categories.map((cat) => `<option value="${esc(cat)}">${esc(cat)}</option>`).join('')}
          </select>` : ''}
          <a class="btn small secondary" href="${BASE}/api/contests/${c.id}/race-results?format=csv" download>⬇ ${t('export_csv')}</a>
          <a class="btn small secondary" href="${BASE}/api/contests/${c.id}/taps" download>⬇ ${t('export_taps')}</a>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('category')}</th>
          <th>${t('category_place')}</th><th>${t('distance')}</th><th>${t('wave')}</th><th>${t('laps')}</th><th>${t('elapsed_col')}</th><th>${t('behind')}</th>
        </tr></thead><tbody id="race-results-body"></tbody></table>
      </div>
    </div>`;

  const draw = (results) => {
    const filter = box.querySelector('#cat-filter');
    const cat = filter ? filter.value : '';
    const rows = results.filter((r) => !cat || r.category === cat);
    const finished = rows.filter((r) => r.status === 'finished');
    const others = rows.filter((r) => r.status !== 'finished');
    const body = box.querySelector('#race-results-body');
    if (!body) return;
    body.innerHTML = [
      ...finished.map((r) => `
        <tr class="${r.rank <= 3 && !cat ? 'top' + r.rank : ''}">
          <td><strong>${!cat ? (MEDALS[r.rank] || r.rank) : r.category_rank}</strong></td>
          <td><strong>${esc(r.bib || '')}</strong></td>
          <td>${esc(r.participant)}</td>
          <td>${esc(r.category || '')}</td>
          <td>${r.category_rank ?? ''}</td>
          <td>${esc(r.distance || '')}</td>
          <td>${esc(r.wave || '')}</td>
          <td>${r.laps}</td>
          <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed}</strong></td>
          <td style="font-variant-numeric:tabular-nums" class="muted">${esc(r.behind || '')}</td>
        </tr>`),
      ...others.map((r) => `
        <tr>
          <td class="muted">–</td>
          <td><strong>${esc(r.bib || '')}</strong></td>
          <td>${esc(r.participant)}</td>
          <td>${esc(r.category || '')}</td>
          <td></td>
          <td>${esc(r.distance || '')}</td>
          <td>${esc(r.wave || '')}</td>
          <td>${r.laps || ''}</td>
          <td class="muted">${RACE_STATUS_LABEL()[r.status] || r.status}</td>
          <td></td>
        </tr>`),
    ].join('') || `<tr><td colspan="10" class="muted">${t('no_results_yet')}</td></tr>`;
  };
  draw(data.results);

  const filter = box.querySelector('#cat-filter');
  const refetch = async () => {
    const fresh = await api(`/contests/${c.id}/race-results`);
    draw(fresh.results);
  };
  if (filter) filter.onchange = refetch;

  closeSse();
  state.sse = new EventSource(`${BASE}/api/contests/${c.id}/stream`);
  state.sse.addEventListener('tag_reads', refetch);
  state.sse.addEventListener('wave_start', refetch);
}

// ---------- public results page (the shareable /race-results/<id> link) ----------

async function viewPublicResults(id, tab) {
  closeSse();
  tab = (tab || 'winners').split('?')[0]; // the tab segment may carry a ?filter query
  const c = await api(`/contests/${id}`).catch(() => null);
  if (!c) { main.innerHTML = `<div class="card">${t('no_results_yet')}</div>`; return; }
  const data = await api(`/contests/${id}/race-results`);

  const hasLaps = data.results.some((r) => (r.laps || 0) > 1);
  const tabs = [['winners', 'race_winners'], ['top3', 'top3_finishers'], ['full', 'full_results']];
  if (hasLaps) tabs.push(['laps', 'lap_times']);
  main.innerHTML = `
    <div class="pubresults">
      <h1 style="text-align:center;margin-bottom:2px">${esc(c.title)}</h1>
      <p style="text-align:center;margin:0 0 12px;color:#666">${esc(new Date(c.start_at).toLocaleString())} — ${t('live_results_label')}</p>
      ${raceInfoPanel(c, data.results)}
      <div class="pubtabs">
        ${tabs.map(([k, key]) => `<a class="pubtab ${tab === k ? 'active' : ''}" href="#/results/${id}/${k}">${t(key)}</a>`).join('')}
      </div>
      <div style="text-align:center;margin:8px 0">
        <a class="btn small secondary" href="${BASE}/api/contests/${id}/race-results?format=csv" download>⬇ ${t('export_csv')}</a>
        <a class="btn small secondary" href="${BASE}/api/contests/${id}/taps" download>⬇ ${t('export_taps')}</a>
      </div>
      <div id="pubbody"></div>
    </div>`;

  const render = (results) => {
    const body = document.getElementById('pubbody');
    if (!body) return;
    const qi = location.hash.indexOf('?');
    const qs = qi >= 0 ? new URLSearchParams(location.hash.slice(qi + 1)) : null;
    if (tab === 'live' && qs && qs.has('dist')) {
      body.innerHTML = liveRaceView(results, id, qs.get('dist') || '', qs.get('cat') || '', qs.get('gender') || '');
    } else if (qs && qs.has('dist')) {
      body.innerHTML = filteredResultsTable(results, id, qs.get('dist') || '', qs.get('cat') || '', qs.get('gender') || '');
    } else if (tab === 'full') body.innerHTML = fullResultsTable(results);
    else if (tab === 'laps') body.innerHTML = lapTimesTables(results);
    else if (tab === 'top3') body.innerHTML = topFinishersTables(results, 3);
    else body.innerHTML = raceWinnersTables(id, results);
  };
  render(data.results);

  state.sse = new EventSource(`${BASE}/api/contests/${id}/stream`);
  const refetch = async () => { const fresh = await api(`/contests/${id}/race-results`); render(fresh.results); };
  state.sse.addEventListener('tag_reads', refetch);
  state.sse.addEventListener('wave_start', refetch);
}

// "Race info" box shown above the results tabs (mirrors the reference layout).
function raceInfoPanel(c, results) {
  const waves = [...new Set(results.map((r) => r.wave).filter(Boolean))];
  const startType = waves.length > 1 ? t('waves_start') : t('mass_start');
  const loc = c.location
    ? `${esc(c.location)} &nbsp;<a href="https://www.google.com/maps/search/${encodeURIComponent(c.location)}" target="_blank" rel="noopener" style="color:var(--brand,#2f8a57);font-weight:600">${t('view_on_map')}</a>`
    : '–';
  const rows = [
    [t('sport'), esc(c.sport) || t('running')],
    [t('location'), loc],
    [t('start_type'), startType],
    [t('racers'), results.length],
    [t('timed_on'), t('timed_on_value')],
    [t('timed_with'), 'VeloGripScorer'],
    [t('chip_timing'), 'RFID - LLRP'],
    [t('updated_from'), t('app_label')],
    [t('race_visibility'), c.visibility === 'public' ? t('visibility_public') : t('visibility_private')],
  ];
  const photo = c.photo_url
    ? `<img src="${c.photo_url}" alt="" style="max-width:340px;width:100%;border-radius:8px;object-fit:cover;align-self:flex-start">` : '';
  return `<div style="display:flex;gap:16px;flex-wrap:wrap;justify-content:center;align-items:flex-start;margin-bottom:16px">
    ${photo}
    <div class="card" style="max-width:520px;flex:1;min-width:280px;margin:0">
      <div style="background:var(--menu-section-bg,#eee);font-weight:700;padding:6px 12px;margin:-16px -16px 10px;border-radius:8px 8px 0 0">${t('race_info')}</div>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${rows.map(([k, v]) => `<tr>
          <td style="text-align:right;color:#777;padding:3px 10px 3px 0;white-space:nowrap;vertical-align:top">${k}:</td>
          <td style="font-weight:600">${v}</td></tr>`).join('')}</tbody>
      </table>
      <div style="border-top:1px solid #ddd;margin-top:8px;padding-top:8px;color:#777">
        ${t('organized_by')}: <strong style="color:#222">${esc(c.organizer_name || (c.organizer && c.organizer.name) || '')}</strong>
      </div>
    </div>
  </div>`;
}

// One table per multi-lap distance: each finisher with a column per lap split.
function lapTimesTables(results) {
  const byDist = groupByDistance(results);
  const dists = [...byDist.keys()].sort();
  let html = '';
  for (const d of dists) {
    const rows = byDist.get(d)
      .filter((r) => r.status === 'finished' && (r.lap_splits ? r.lap_splits.length : 0) > 0)
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
    const maxLaps = rows.reduce((m, r) => Math.max(m, r.lap_splits.length), 0);
    if (maxLaps < 2) continue; // lap-times view is only meaningful for multi-lap races
    const lapCols = Array.from({ length: maxLaps }, (_, i) => `<th>${t('lap')} ${i + 1}</th>`).join('');
    html += `<div style="overflow-x:auto"><table class="board mt"><thead>
      <tr><th colspan="${3 + maxLaps + 1}">${esc(d || t('overall'))}</th></tr>
      <tr><th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th>${lapCols}<th>${t('elapsed_col')}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><strong>${r.rank}</strong></td><td><strong>${esc(r.bib || '')}</strong></td><td>${esc(r.participant)}</td>
        ${Array.from({ length: maxLaps }, (_, i) => `<td style="font-variant-numeric:tabular-nums">${r.lap_splits[i] ? esc(r.lap_splits[i]) : '–'}</td>`).join('')}
        <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed}</strong></td></tr>`).join('')}</tbody></table></div>`;
  }
  return html || `<p class="muted">${t('no_lap_races')}</p>`;
}

// distance -> ordered category groups (Overall first, then each category)
function groupByDistance(results) {
  const byDist = new Map();
  for (const r of results) {
    const d = r.distance || '';
    if (!byDist.has(d)) byDist.set(d, []);
    byDist.get(d).push(r);
  }
  return byDist;
}

function leaderOf(rows) {
  const finished = rows.filter((r) => r.status === 'finished')
    .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
  return finished[0] || null;
}

function isFemaleW(g) { g = String(g || '').trim().toLowerCase(); return ['f', 'female', 'נקבה', 'אישה'].includes(g); }
function isMaleW(g) { g = String(g || '').trim().toLowerCase(); return ['m', 'male', 'זכר', 'גבר'].includes(g); }
function genderShort(g) { return isMaleW(g) ? 'M' : isFemaleW(g) ? 'F' : ''; }

// mm:ss.t / h:mm:ss.t from milliseconds (matches the server's formatElapsed)
function fmtElapsedMs(ms) {
  const units = Math.round(Math.max(0, ms) / 100); // tenths of a second
  const tenths = units % 10, totalS = Math.floor(units / 10);
  const s = totalS % 60, m = Math.floor(totalS / 60) % 60, h = Math.floor(totalS / 3600);
  const head = h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`;
  return `${head}:${String(s).padStart(2, '0')}.${tenths}`;
}

// Live race / progress view: scope summary (finished / on course / not
// started) plus the live finish order. Refreshes with the results via SSE.
function liveRaceView(results, id, dist, cat, gender) {
  let scope = results.filter((r) => (r.distance || '') === dist);
  if (gender === 'Male') scope = scope.filter((r) => isMaleW(r.gender));
  else if (gender === 'Female') scope = scope.filter((r) => isFemaleW(r.gender));
  if (cat) scope = scope.filter((r) => r.category === cat);
  const finished = scope.filter((r) => r.status === 'finished').sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
  const onCourse = scope.filter((r) => r.status === 'on_course');
  const notStarted = scope.filter((r) => r.status === 'not_started');
  const leader = finished[0] || null;
  const genderCrumb = gender === 'Male' ? t('male') + ' ' : gender === 'Female' ? t('female') + ' ' : '';
  const crumb = `${esc(dist || t('overall'))} ${genderCrumb}- ${cat ? esc(cat) : t('overall')}`;
  const nameCell = (r) => `${esc(r.participant)}${r.team ? `<div class="muted" style="font-size:.78rem">${esc(r.team)}</div>` : ''}`;
  const stat = (n, label, bg) => `<div style="flex:1;min-width:88px;text-align:center;padding:10px;border-radius:8px;background:${bg}">
    <div style="font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums">${n}</div>
    <div class="muted" style="font-size:.8rem">${label}</div></div>`;
  const finishedHtml = finished.map((r, i) => {
    const diff = !leader || r.elapsed_ms === leader.elapsed_ms
      ? (i === 0 ? '–' : '') : '+' + fmtElapsedMs(r.elapsed_ms - leader.elapsed_ms);
    return `<tr><td><strong>${r.rank}</strong></td><td>${esc(r.bib || '')}</td><td>${nameCell(r)}</td>
      <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed}</strong></td>
      <td class="muted" style="font-variant-numeric:tabular-nums">${diff}</td></tr>`;
  }).join('') || `<tr><td colspan="5" class="muted">${t('no_results_yet')}</td></tr>`;
  const onCourseHtml = onCourse.length
    ? `<h3 style="margin:16px 0 6px">${t('status_on_course')} <span class="muted">(${onCourse.length})</span></h3>
       <div style="display:flex;flex-wrap:wrap;gap:6px">${onCourse
      .sort((a, b) => bibNumW(a.bib) - bibNumW(b.bib))
      .map((r) => `<span class="pill">${esc(r.bib || '')} · ${esc(r.participant)}</span>`).join('')}</div>` : '';
  return `
    <p style="margin:12px 0 8px"><a href="#/results/${id}/winners" style="color:var(--brand,#2f8a57);font-weight:700">${t('race_winners')}</a>
      <span class="muted"> » ${crumb} — ${t('live_race')}</span></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      ${stat(scope.length, t('racers'), 'var(--menu-section-bg,#eeeeee)')}
      ${stat(finished.length, t('status_finished_r'), '#e6f2da')}
      ${stat(onCourse.length, t('status_on_course'), '#fdf3d0')}
      ${stat(notStarted.length, t('status_not_started'), '#f0f0f0')}
    </div>
    <div style="overflow-x:auto"><table class="board"><thead><tr>
      <th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('finish_time')}</th><th>${t('difference')}</th>
    </tr></thead><tbody>${finishedHtml}</tbody></table></div>
    ${onCourseHtml}`;
}

function bibNumW(bib) { const n = parseInt(String(bib || '').replace(/[^0-9]/g, ''), 10); return Number.isNaN(n) ? 1e9 : n; }

// The detailed table behind a Race-winners link: one distance + optional
// gender + optional category, with each racer's team shown under their name.
function filteredResultsTable(results, id, dist, cat, gender) {
  let scope = results.filter((r) => (r.distance || '') === dist);
  if (gender === 'Male') scope = scope.filter((r) => isMaleW(r.gender));
  else if (gender === 'Female') scope = scope.filter((r) => isFemaleW(r.gender));
  if (cat) scope = scope.filter((r) => r.category === cat);
  const finished = scope.filter((r) => r.status === 'finished').sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
  const others = scope.filter((r) => r.status !== 'finished');
  const leader = finished[0] || null;
  const genderCrumb = gender === 'Male' ? t('male') + ' ' : gender === 'Female' ? t('female') + ' ' : '';
  const crumb = `${esc(dist || t('overall'))} ${genderCrumb}- ${cat ? esc(cat) : t('overall')}`;
  const nameCell = (r) => `${esc(r.participant)}${r.team ? `<div class="muted" style="font-size:.78rem">${esc(r.team)}</div>` : ''}`;
  let prevMs = null, prevPlace = 0;
  const finishedHtml = finished.map((r, i) => {
    const place = (prevMs !== null && r.elapsed_ms === prevMs) ? prevPlace : i + 1;
    prevMs = r.elapsed_ms; prevPlace = place;
    const diff = !leader || r.elapsed_ms === leader.elapsed_ms
      ? (i === 0 ? '–' : '') : '+' + fmtElapsedMs(r.elapsed_ms - leader.elapsed_ms);
    return `<tr>
      <td><strong>${place}</strong></td><td>${esc(r.bib || '')}</td><td>${nameCell(r)}</td>
      <td>${esc(r.category || '')}</td><td>${genderShort(r.gender)}</td>
      <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed}</strong></td>
      <td class="muted" style="font-variant-numeric:tabular-nums">${diff}</td></tr>`;
  }).join('');
  const othersHtml = others.map((r) => `<tr>
      <td class="muted">–</td><td>${esc(r.bib || '')}</td><td>${nameCell(r)}</td>
      <td>${esc(r.category || '')}</td><td>${genderShort(r.gender)}</td>
      <td class="muted">${RACE_STATUS_LABEL()[r.status] || r.status}</td><td></td></tr>`).join('');
  return `
    <p style="margin:12px 0 6px"><a href="#/results/${id}/winners" style="color:var(--brand,#2f8a57);font-weight:700">${t('race_winners')}</a>
      <span class="muted"> » ${crumb}</span></p>
    <div style="overflow-x:auto"><table class="board mt"><thead><tr>
      <th>${t('place')}</th><th>${t('bib')}</th>
      <th>${t('participant')}<br><span class="muted" style="font-weight:400;font-size:.72rem">${t('affiliation')}</span></th>
      <th>${t('category')}</th><th>${t('gender_col')}</th><th>${t('finish_time')}</th><th>${t('difference')}</th>
    </tr></thead><tbody>${finishedHtml}${othersHtml}</tbody></table></div>`;
}

function raceWinnersTables(id, results) {
  const byDist = groupByDistance(results);
  const dists = [...byDist.keys()].sort();
  return `<p class="muted" style="margin:8px 0">▸ ${t('click_green_category')}</p>` + dists.map((d) => {
    const rows = byDist.get(d);
    const multiLap = rows.some((r) => (r.laps || 0) > 1);
    const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
    const seg = (view, catFilter, gender) => `#/results/${id}/${view}?dist=${encodeURIComponent(d)}`
      + `&cat=${encodeURIComponent(catFilter || '')}&gender=${encodeURIComponent(gender || '')}`;
    const line = (label, scope, indent, catFilter, gender) => {
      const leader = leaderOf(scope);
      return `<tr>
        <td style="padding-left:${indent}px"><a href="${seg('winners', catFilter, gender)}" class="cat-link">▸ ${esc(label)}</a></td>
        <td>${leader ? esc(leader.participant) : '–'}</td>
        <td style="font-variant-numeric:tabular-nums">${leader ? leader.elapsed : '–'}</td>
        <td><strong>${scope.length}</strong></td>
        <td><a href="${seg('live', catFilter, gender)}" class="live-link">▸ ${t('live_race')}</a></td>
        ${multiLap ? `<td><a href="#/results/${id}/laps">▸ ${t('lap_times')}</a></td>` : ''}
      </tr>`;
    };
    return `
      <table class="board winners mt">
        <thead><tr>
          <th>${esc(d || t('overall'))}</th><th>${t('leader')}</th><th>${t('leading_time')}</th>
          <th>${t('total_racers')}</th><th>${t('progress_view')}</th>
          ${multiLap ? `<th>${t('lap_times')}</th>` : ''}
        </tr></thead>
        <tbody>
          ${line(t('overall'), rows, 0, '', '')}
          ${rows.some((r) => isFemaleW(r.gender)) ? line(t('female'), rows.filter((r) => isFemaleW(r.gender)), 20, '', 'Female') : ''}
          ${rows.some((r) => isMaleW(r.gender)) ? line(t('male'), rows.filter((r) => isMaleW(r.gender)), 20, '', 'Male') : ''}
          ${cats.map((cat) => line(cat, rows.filter((r) => r.category === cat), 20, cat, '')).join('')}
        </tbody>
      </table>`;
  }).join('');
}

function topFinishersTables(results, n) {
  const byDist = groupByDistance(results);
  const dists = [...byDist.keys()].sort();
  return dists.map((d) => {
    const rows = byDist.get(d);
    const cats = ['', ...[...new Set(rows.map((r) => r.category).filter(Boolean))].sort()];
    return cats.map((cat) => {
      const scope = (cat ? rows.filter((r) => r.category === cat) : rows)
        .filter((r) => r.status === 'finished')
        .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))
        .slice(0, n);
      if (!scope.length) return '';
      return `
        <table class="board mt">
          <thead><tr><th colspan="4">${esc(d || t('overall'))}${cat ? ' — ' + esc(cat) : ' — ' + t('overall')}</th></tr>
          <tr><th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('elapsed_col')}</th></tr></thead>
          <tbody>${scope.map((r, i) => `<tr class="top${i + 1}">
            <td><strong>${MEDALS[i + 1] || (i + 1)}</strong></td><td><strong>${esc(r.bib || '')}</strong></td>
            <td>${esc(r.participant)}</td>
            <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed}</strong></td></tr>`).join('')}</tbody>
        </table>`;
    }).join('');
  }).join('') || `<p class="muted">${t('no_results_yet')}</p>`;
}

function fullResultsTable(results) {
  const finished = results.filter((r) => r.status === 'finished');
  const others = results.filter((r) => r.status !== 'finished');
  const rows = [
    ...finished.map((r) => `<tr class="${r.rank <= 3 ? 'top' + r.rank : ''}">
      <td><strong>${MEDALS[r.rank] || r.rank}</strong></td><td><strong>${esc(r.bib || '')}</strong></td>
      <td>${esc(r.participant)}${r.team ? `<div class="muted" style="font-size:.78rem">${esc(r.team)}</div>` : ''}</td><td>${esc(r.category || '')}</td><td>${r.category_rank ?? ''}</td>
      <td>${esc(r.distance || '')}</td><td>${r.laps}</td>
      <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed}</strong></td>
      <td class="muted" style="font-variant-numeric:tabular-nums">${esc(r.behind || '')}</td></tr>`),
    ...others.map((r) => `<tr>
      <td class="muted">–</td><td><strong>${esc(r.bib || '')}</strong></td>
      <td>${esc(r.participant)}${r.team ? `<div class="muted" style="font-size:.78rem">${esc(r.team)}</div>` : ''}</td><td>${esc(r.category || '')}</td><td></td>
      <td>${esc(r.distance || '')}</td><td>${r.laps || ''}</td>
      <td class="muted">${RACE_STATUS_LABEL()[r.status] || r.status}</td><td></td></tr>`),
  ].join('') || `<tr><td colspan="9" class="muted">${t('no_results_yet')}</td></tr>`;
  return `<div style="overflow-x:auto"><table class="board mt"><thead><tr>
    <th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('category')}</th>
    <th>${t('category_place')}</th><th>${t('distance')}</th><th>${t('laps')}</th>
    <th>${t('elapsed_col')}</th><th>${t('behind')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function renderStartlist(box, c) {
  const { racers, waves } = await api(`/contests/${c.id}/startlist`);
  box.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${t('tab_startlist')} <span class="muted" style="font-weight:400">(${racers.length} ${t('racers_count')})</span></h3>
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('bib')}</th><th>${t('participant')}</th><th>${t('team')}</th><th>${t('category')}</th><th>${t('distance')}</th><th>${t('wave')}</th><th>${t('racer_status')}</th>
        </tr></thead><tbody>
          ${racers.map((r) => `
            <tr>
              <td><strong>${esc(r.bib || '')}</strong></td>
              <td>${esc(r.participant)}</td>
              <td>${esc(r.team || '')}</td>
              <td>${esc(r.category || '')}</td>
              <td>${esc(r.distance || '')}</td>
              <td>${esc(r.wave || '')}</td>
              <td>${r.racer_status ? `<span class="pill finished">${esc(r.racer_status)}</span>` : ''}</td>
            </tr>`).join('') || `<tr><td colspan="7" class="muted">${t('no_startlist')}</td></tr>`}
        </tbody></table>
      </div>
      ${waves.length ? `<p class="muted">${waves.map((w) => `${esc(w.name)}: ${w.started_at ? fmtDate(w.started_at) : t('not_started')}`).join(' · ')}</p>` : ''}
    </div>`;
}

// ---------- manage tab (organizer): start list, app pairing, settings ----------

async function renderManage(box, c) {
  const generation = renderGeneration;
  const [{ tags }, wavesData] = await Promise.all([
    api(`/contests/${c.id}/tags`),
    api(`/contests/${c.id}/waves`),
  ]);
  if (generation !== renderGeneration) return;
  const waves = wavesData.waves;
  const $ = (sel) => box.querySelector(sel);

  box.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">📱 ${t('app_pairing')}</h3>
      <p class="muted" style="margin:4px 0">${t('app_pairing_help')}</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <code style="font-size:0.8rem;overflow-wrap:anywhere">${esc(c.app_token || '')}</code>
        <button class="btn small secondary" id="copy-token">${t('copy')}</button>
      </div>
    </div>

    <div class="card mt">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <h3 style="margin:0">${t('tab_startlist')} <span class="muted" style="font-weight:400">(${tags.length} ${t('racers_count')})</span></h3>
        <div>
          <input type="file" id="csv-file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
          <button class="btn small" id="import-csv" title="${t('csv_help')}">⬆ ${t('import_csv')}</button>
        </div>
      </div>
      <p class="muted" style="font-size:0.78rem;margin:2px 0 8px">${t('csv_help')}</p>
      <form id="tag-form" style="display:flex;gap:6px;flex-wrap:wrap">
        <input name="bib" placeholder="${t('bib')}" style="width:70px">
        <input name="participant" placeholder="${t('participant')}" required style="flex:2;min-width:110px">
        <input name="category" placeholder="${t('category')}" style="flex:1;min-width:80px">
        <select name="wave_id" aria-label="${t('wave')}" style="flex:1;min-width:90px">
          <option value="">${t('wave')} —</option>
          ${waves.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
        </select>
        <input name="epc" placeholder="${t('epc_optional')}" pattern="[0-9A-Fa-f]{4,64}" style="flex:2;min-width:120px">
        <input name="epc2" placeholder="${t('epc2_optional')}" pattern="[0-9A-Fa-f]{4,64}" style="flex:2;min-width:120px">
        <button class="btn small">${t('assign')}</button>
      </form>
      <div id="tags-list" class="mt" style="max-height:420px;overflow:auto">
        ${tags.map((a, i) => `
          <div class="comment" style="display:flex;gap:8px;align-items:center">
            <strong>#${esc(a.bib || '—')}</strong> ${esc(a.participant)}
            ${a.category ? `<span class="pill tag">${esc(a.category)}</span>` : ''}
            ${a.wave_name ? `<span class="pill">${esc(a.wave_name)}</span>` : ''}
            <code style="font-size:0.7rem;overflow-wrap:anywhere" class="muted">${esc((a.epcs || [a.epc]).join(' + '))}</code>
            <select class="tag-status" data-idx="${i}" aria-label="${t('racer_status')}" style="width:auto;margin-inline-start:auto;padding:2px 6px">
              ${['', 'DNS', 'DNF', 'DSQ'].map((s) => `<option value="${s}" ${a.racer_status === s ? 'selected' : ''}>${s || t('status_ok')}</option>`).join('')}
            </select>
            <button class="ghost tag-del" data-epc="${esc(a.epc)}" aria-label="${t('delete')}">🗑</button>
          </div>`).join('') || `<p class="muted">${t('no_startlist')}</p>`}
      </div>
    </div>

    <div class="card mt">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${t('waves')}</h3>
        <form id="timing-settings" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:0.85rem">
          <label style="margin:0;font-weight:400">${t('suppress')}</label>
          <input name="suppress" type="number" min="0" value="${wavesData.suppress_secs}" style="width:70px">
          <label style="margin:0;font-weight:400">${t('lap_gap')}</label>
          <input name="lapgap" type="number" min="0" value="${wavesData.min_lap_gap_secs}" style="width:70px">
          <button class="btn small secondary">${t('save_settings')}</button>
        </form>
      </div>
      <p class="muted" style="font-size:0.78rem">${t('waves_help')}</p>
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('wave')}</th><th>${t('racers_count')}</th><th>${t('started_at')}</th><th></th>
        </tr></thead><tbody>
          ${waves.map((w) => `
            <tr>
              <td><strong>${esc(w.name)}</strong></td>
              <td>${w.racer_count}</td>
              <td>${w.started_at ? fmtDate(w.started_at) : `<span class="muted">${t('not_started')}</span>`}</td>
              <td><button class="ghost wave-del" data-id="${w.id}" aria-label="${t('delete')}">🗑</button></td>
            </tr>`).join('') || `<tr><td colspan="4" class="muted">—</td></tr>`}
        </tbody></table>
      </div>
      <form id="wave-form" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <input name="name" placeholder="${t('wave')}" required style="max-width:220px">
        <button class="btn small secondary">+ ${t('add_wave')}</button>
      </form>
    </div>

    <div class="card mt" style="border-color:var(--danger)">
      <h3 style="margin-top:0;color:var(--danger)">${t('danger_zone')}</h3>
      <p class="muted" style="font-size:0.85rem">${t('delete_race_help')}</p>
      <button class="btn small danger" id="delete-race">🗑 ${t('delete_race')}</button>
    </div>`;

  $('#copy-token').onclick = async () => {
    try { await navigator.clipboard.writeText(c.app_token || ''); toast(t('copied')); }
    catch { prompt(t('copy'), c.app_token || ''); }
  };

  // ---- CSV start-list import ----
  const csvFile = $('#csv-file');
  $('#import-csv').onclick = () => csvFile.click();
  csvFile.onchange = async () => {
    const file = csvFile.files[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.set('file', file);
      const result = await api(`/contests/${c.id}/startlist-file`, { method: 'POST', form });
      toast(t('import_done', { n: result.imported, s: result.skipped })
        + (result.errors.length ? ' — ' + result.errors[0] : ''), result.errors.length > 0);
      viewContest(c.id, 'manage');
    } catch (err) { toast(err.message, true); }
    csvFile.value = '';
  };

  $('#tag-form').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const epc = form.epc.value.trim() || (/^\d{1,10}$/.test(form.bib.value.trim())
      ? 'AA' + form.bib.value.trim().padStart(4, '0') : '');
    try {
      if (!epc) throw new Error(t('epc_or_bib'));
      await api(`/contests/${c.id}/tags`, { method: 'POST', body: {
        epc, epc2: form.epc2.value.trim(), bib: form.bib.value, participant: form.participant.value,
        category: form.category.value, wave_id: form.wave_id.value ? Number(form.wave_id.value) : null,
      }});
      viewContest(c.id, 'manage');
    } catch (err) { toast(err.message, true); }
  };
  box.querySelectorAll('.tag-del').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/contests/${c.id}/tags/${btn.dataset.epc}`, { method: 'DELETE' });
      viewContest(c.id, 'manage');
    };
  });
  box.querySelectorAll('.tag-status').forEach((sel) => {
    sel.onchange = async () => {
      const a = tags[Number(sel.dataset.idx)];
      try {
        await api(`/contests/${c.id}/tags`, { method: 'POST', body: {
          epc: a.epc, bib: a.bib, participant: a.participant, category: a.category,
          wave_id: a.wave_id, racer_status: sel.value,
        }});
        toast('✓');
      } catch (err) { toast(err.message, true); }
    };
  });

  $('#wave-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/contests/${c.id}/waves`, { method: 'POST', body: { name: e.target.name.value } });
      viewContest(c.id, 'manage');
    } catch (err) { toast(err.message, true); }
  };
  box.querySelectorAll('.wave-del').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(t('delete') + '?')) return;
      await api(`/contests/${c.id}/waves/${btn.dataset.id}`, { method: 'DELETE' });
      viewContest(c.id, 'manage');
    };
  });
  $('#delete-race').onclick = async () => {
    const typed = prompt(t('delete_race_confirm', { title: c.title }));
    if (typed === null) return;
    if (typed.trim() !== c.title) { toast(t('delete_race_mismatch'), true); return; }
    try {
      await api(`/contests/${c.id}`, { method: 'DELETE' });
      toast('🗑 ✓');
      location.hash = '#/';
    } catch (err) { toast(err.message, true); }
  };

  $('#timing-settings').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/contests/${c.id}/timing-settings`, { method: 'PATCH', body: {
        suppress_secs: Number(e.target.suppress.value), min_lap_gap_secs: Number(e.target.lapgap.value),
      }});
      toast('✓');
    } catch (err) { toast(err.message, true); }
  };
}


// ---------- profile ----------

async function viewProfile(id) {
  const isMe = state.user && state.user.id === id;
  const data = await api(`/users/${id}/activity`).catch(async () => ({ user: await api(`/users/${id}`), created_contests: [], joined_contests: [], awards: [], private: true }));
  const u = data.user;
  main.innerHTML = `
    <div class="card" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      ${avatar(u.avatar_url, u.name)}
      <div>
        <h1 style="margin:0">${esc(u.name)}</h1>
        <p class="muted" style="margin:2px 0">${esc(u.bio || '')}</p>
        ${u.reputation !== undefined ? `<span class="pill">⭐ ${u.reputation} rep</span>` : ''}
      </div>
      ${isMe ? `<button class="btn small secondary" id="edit-profile" style="margin-inline-start:auto">✏️</button>
        <button class="btn small secondary" id="change-password">${t('change_password')}</button>
        <button class="btn small secondary" id="export-data">${t('export_my_data')}</button>` : ''}
    </div>
    <div id="edit-box"></div>
    ${data.private ? '' : `
    <div class="detail-grid mt">
      <div class="card">
        <h3>${t('created_contests')}</h3>
        ${data.created_contests.map((c) => `<p><a href="#/contest/${c.id}">${esc(c.title)}</a> <span class="pill ${c.status === 'finished' ? 'finished' : ''}">${t('status_' + (c.status === 'finished' ? 'finished' : 'active'))}</span></p>`).join('') || `<p class="muted">—</p>`}
        <h3>${t('joined_contests')}</h3>
        ${data.joined_contests.map((c) => `<p><a href="#/contest/${c.id}">${esc(c.title)}</a></p>`).join('') || `<p class="muted">—</p>`}
      </div>
      <div class="card">
        <h3>${t('wins_badges')}</h3>
        ${data.awards.map((a) => `<p>${MEDALS[a.rank] || '🎖'} <strong>${esc(a.badge)}</strong> — <a href="#/contest/${a.contest_id}">${esc(a.contest_title)}</a></p>`).join('') || `<p class="muted">—</p>`}
      </div>
    </div>`}`;

  const exportBtn = document.getElementById('export-data');
  if (exportBtn) exportBtn.onclick = async () => {
    const res = await fetch(`${BASE}/api/users/me/export`, { headers: { Authorization: `Bearer ${state.token}` } });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = 'my-data.json';
    a.click();
  };
  const pwBtn = document.getElementById('change-password');
  if (pwBtn) pwBtn.onclick = () => {
    document.getElementById('edit-box').innerHTML = `
      <form class="card mt form-narrow" id="password-form">
        <label for="pw-current">${t('current_password')}</label>
        <input id="pw-current" type="password" autocomplete="current-password">
        <label for="pw-new">${t('new_password')}</label>
        <input id="pw-new" type="password" autocomplete="new-password">
        <label for="pw-confirm">${t('confirm_password')}</label>
        <input id="pw-confirm" type="password" autocomplete="new-password">
        <button class="btn mt">${t('save')}</button>
      </form>`;
    document.getElementById('password-form').onsubmit = async (e) => {
      e.preventDefault();
      const current = document.getElementById('pw-current').value;
      const next = document.getElementById('pw-new').value;
      const confirm = document.getElementById('pw-confirm').value;
      if (next !== confirm) return toast(t('passwords_dont_match'), true);
      try {
        await api('/users/me/password', { method: 'POST', body: {
          current_password: current, new_password: next,
        }});
        document.getElementById('edit-box').innerHTML = '';
        toast(t('password_changed'));
      } catch (err) { toast(err.message, true); }
    };
  };
  const editBtn = document.getElementById('edit-profile');
  if (editBtn) editBtn.onclick = () => {
    document.getElementById('edit-box').innerHTML = `
      <form class="card mt form-narrow" id="profile-form">
        <label for="p-name">${t('display_name')}</label><input id="p-name" value="${esc(u.name)}">
        <label for="p-bio">${t('bio')}</label><textarea id="p-bio" rows="3">${esc(u.bio || '')}</textarea>
        <label for="p-avatar">${t('avatar_url')}</label><input id="p-avatar" value="${esc(u.avatar_url || '')}">
        <label><input type="checkbox" id="p-public" style="width:auto" ${u.is_public ? 'checked' : ''}> ${t('profile_public')}</label>
        <button class="btn mt">${t('save')}</button>
      </form>`;
    document.getElementById('profile-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const updated = await api('/users/me', { method: 'PATCH', body: {
          name: document.getElementById('p-name').value,
          bio: document.getElementById('p-bio').value,
          avatar_url: document.getElementById('p-avatar').value,
          is_public: document.getElementById('p-public').checked,
        }});
        setSession(state.token, updated);
        viewProfile(id);
      } catch (err) { toast(err.message, true); }
    };
  };
}

// ---------- admin ----------

async function viewAdmin(section) {
  if (!state.user || state.user.role !== 'admin') { main.innerHTML = `<div class="card">${t('need_login')}</div>`; return; }
  main.innerHTML = `
    <div class="tabs" role="tablist">
      ${['reports', 'users', 'audit'].map((s) => `<button role="tab" aria-selected="${s === section}" data-s="${s}">${t('admin_' + (s === 'audit' ? 'audit' : s))}</button>`).join('')}
    </div>
    <div id="admin-box"></div>`;
  main.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => { location.hash = `#/admin/${b.dataset.s}`; }));
  const box = document.getElementById('admin-box');

  if (section === 'reports') {
    const { reports } = await api('/admin/reports');
    box.innerHTML = reports.length ? reports.map((r) => `
      <div class="card mt">
        <div><strong>${esc(r.target_type)} #${r.target_id}</strong> — ${t('reported_by')} ${esc(r.reporter_name)} <time class="muted">${fmtDate(r.created_at)}</time></div>
        <div>${t('reason')}: ${esc(r.reason)}</div>
        ${r.target ? `<pre style="background:var(--bg);padding:8px;border-radius:6px;overflow-x:auto;max-height:140px">${esc(JSON.stringify(r.target, null, 1).slice(0, 800))}</pre>` : ''}
        <div style="display:flex;gap:8px">
          <button class="btn small secondary" data-act="dismiss" data-id="${r.id}">${t('dismiss')}</button>
          <button class="btn small danger" data-act="remove" data-id="${r.id}">${t('remove_content')}</button>
          <button class="btn small danger" data-act="ban" data-id="${r.id}">${t('ban_user')}</button>
        </div>
      </div>`).join('') : `<p class="muted mt">${t('no_reports')}</p>`;
    box.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        try { await api(`/admin/reports/${btn.dataset.id}/resolve`, { method: 'POST', body: { action: btn.dataset.act } }); viewAdmin('reports'); }
        catch (err) { toast(err.message, true); }
      };
    });
  } else if (section === 'users') {
    const { users } = await api('/admin/users');
    box.innerHTML = `<div class="card mt" style="overflow-x:auto"><table class="board">
      <thead><tr><th>ID</th><th>${t('display_name')}</th><th>${t('email')}</th><th>Role</th><th>Rep</th><th></th></tr></thead>
      <tbody>${users.map((u) => `
        <tr><td>${u.id}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role}</td><td>${u.reputation}</td>
        <td><button class="btn small ${u.is_banned ? 'secondary' : 'danger'}" data-ban="${u.id}" data-to="${u.is_banned ? 0 : 1}">
          ${u.is_banned ? 'Unban' : t('ban_user')}</button></td></tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('[data-ban]').forEach((btn) => {
      btn.onclick = async () => {
        await api(`/admin/users/${btn.dataset.ban}/ban`, { method: 'POST', body: { banned: btn.dataset.to === '1' } });
        viewAdmin('users');
      };
    });
  } else {
    const { audit_log } = await api('/admin/audit-log');
    box.innerHTML = `<div class="card mt" style="overflow-x:auto"><table class="board">
      <thead><tr><th>#</th><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>Time</th></tr></thead>
      <tbody>${audit_log.map((a) => `
        <tr><td>${a.id}</td><td>${esc(a.user_name || '—')}</td><td><code>${esc(a.action)}</code></td>
        <td>${esc(a.target_type)} ${a.target_id ?? ''}</td><td>${esc(a.details)}</td><td class="muted">${fmtDate(a.created_at)}</td></tr>`).join('')}</tbody></table></div>`;
  }
}

// ---------- boot ----------

// Public results deep link: /race-results/<id> -> the spectator results view.
const rr = location.pathname.match(/\/race-results\/(\d+)/);
if (rr) {
  history.replaceState(null, '', BASE + '/#/results/' + rr[1]);
}

setLang(LANG);
renderChrome();
route();

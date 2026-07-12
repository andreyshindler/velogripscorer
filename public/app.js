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
  document.getElementById('nav-create').hidden = !state.user;
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
    if (page === 'create') return viewCreate();
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
      <a class="btn" href="${state.user ? '#/create' : '#/login'}">${t('create_race')}</a>
    </div>
    <form class="searchbar" id="search-form" role="search">
      <input type="search" id="q" placeholder="${t('search_placeholder')}" aria-label="${t('search_placeholder')}">
      <select id="cat" aria-label="${t('category')}">
        <option value="">${t('all_categories')}</option>
        ${['photo', 'design', 'code', 'writing', 'video', 'other'].map((c) => `<option value="${c}">${t('category_' + c)}</option>`).join('')}
      </select>
      <select id="sort" aria-label="sort">
        <option value="newest">${t('sort_newest')}</option>
        <option value="popular">${t('sort_popular')}</option>
      </select>
      <button class="btn" type="submit">🔍</button>
    </form>
    <div id="recommended"></div>
    <h2>${t('races')}</h2>
    <div class="grid" id="contest-list"></div>`;

  document.getElementById('search-form').onsubmit = (e) => { e.preventDefault(); loadContests(); };
  document.getElementById('cat').onchange = loadContests;
  document.getElementById('sort').onchange = loadContests;
  loadContests();

  if (state.user) {
    api('/contests/recommended').then(({ contests }) => {
      if (!contests.length) return;
      document.getElementById('recommended').innerHTML =
        `<h2>${t('recommended')}</h2><div class="grid">${contests.map(contestCard).join('')}</div>`;
    }).catch(() => {});
  }
}

async function loadContests() {
  const q = document.getElementById('q').value;
  const category = document.getElementById('cat').value;
  const sort = document.getElementById('sort').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (sort === 'popular') params.set('sort', 'popular');
  const { contests } = await api(`/contests?${params}`);
  document.getElementById('contest-list').innerHTML = contests.length
    ? contests.map(contestCard).join('')
    : `<p class="muted">${t('no_contests')}</p>`;
}

function contestCard(c) {
  const isRace = c.kind === 'race';
  const started = new Date(c.start_at) <= new Date();
  const statusPill = c.status === 'finished'
    ? `<span class="pill finished">${t('status_finished')}</span>`
    : isRace
      ? (started ? `<span class="pill live">● ${t('hero_live')}</span>` : `<span class="pill">${t('live_upcoming')}</span>`)
      : (c.voting_open ? `<span class="pill live">${t('voting_open_now')}</span>` : `<span class="pill">${t('status_active')}</span>`);
  return `
    <a class="card contest-card" href="#/contest/${c.id}" style="color:inherit;text-decoration:none">
      <div>
        <span class="pill">${isRace ? '🏁 ' + (esc(c.sport) || t('race_kind')) : t('category_' + c.category)}</span>
        ${statusPill}
      </div>
      <h3>${esc(c.title)}</h3>
      ${isRace
        ? `<div class="meta">
            ${c.location ? `<span>📍 ${esc(c.location)}</span>` : ''}
            <span>🗓 ${fmtDate(c.start_at)}</span>
            <span>👤 ${esc(c.organizer_name || '')}</span>
          </div>`
        : `<p class="muted" style="margin:0">${esc((c.description || '').slice(0, 110))}${(c.description || '').length > 110 ? '…' : ''}</p>
          <div class="meta">
            <span>👤 ${esc(c.organizer_name || '')}</span>
            <span>📥 ${c.entry_count ?? 0} ${t('entries')}</span>
            <span>⏱ ${fmtDate(c.end_at)}</span>
          </div>`}
      <div>${(c.tags || []).slice(0, 4).map((tag) => `<span class="pill tag">#${esc(tag)}</span>`).join(' ')}</div>
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

// ---------- create contest ----------

function viewCreate() {
  if (!state.user) { location.hash = '#/login'; return; }
  main.innerHTML = `
    <div class="card form-narrow">
      <h1>${t('create_title')}</h1>
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected="true" id="kind-race">🏁 ${t('race_kind')}</button>
        <button role="tab" aria-selected="false" id="kind-voting">🗳 ${t('voting_kind')}</button>
      </div>
      <form id="create-form">
        <label for="c-title">${t('contest_title')}</label>
        <input id="c-title" required maxlength="120">
        <div class="row2" id="race-only">
          <div>
            <label for="c-sport">${t('sport')}</label>
            <input id="c-sport" placeholder="${t('sport_hint')}" list="sport-list">
            <datalist id="sport-list">
              ${['Cycling — Road', 'Cycling — MTB XCO', 'Cycling — Gravel', 'Running', 'Trail running', 'Triathlon', 'Duathlon', 'Motocross'].map((s) => `<option value="${s}">`).join('')}
            </datalist>
          </div>
          <div>
            <label for="c-location">${t('location')}</label>
            <input id="c-location" placeholder="${t('location_hint')}">
          </div>
        </div>
        <label for="c-desc">${t('description')}</label>
        <textarea id="c-desc" rows="4"></textarea>
        <div class="row2">
          <div id="voting-cat">
            <label for="c-cat">${t('category')}</label>
            <select id="c-cat">
              ${['photo', 'design', 'code', 'writing', 'video', 'other'].map((c) => `<option value="${c}">${t('category_' + c)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label for="c-tags">${t('tags')}</label>
            <input id="c-tags" placeholder="mtb, xco">
          </div>
        </div>
        <div class="row2">
          <div><label for="c-start">${t('start_date')}</label><input id="c-start" type="datetime-local" required></div>
          <div><label for="c-end">${t('end_date')}</label><input id="c-end" type="datetime-local" required></div>
        </div>
        <div class="row2">
          <div>
            <label for="c-visibility">${t('visibility')}</label>
            <select id="c-visibility"><option value="public">${t('public')}</option><option value="private">${t('private')}</option></select>
          </div>
          <div id="voting-mode-box">
            <label for="c-mode">${t('voting_mode')}</label>
            <select id="c-mode"><option value="open">${t('voting_mode_open')}</option><option value="closed">${t('voting_mode_closed')}</option></select>
          </div>
        </div>
        <div id="voting-only">
          <div class="row2" id="vote-window" hidden>
            <div><label for="c-vstart">${t('voting_window')} — ${t('start_date')}</label><input id="c-vstart" type="datetime-local"></div>
            <div><label for="c-vend">${t('voting_window')} — ${t('end_date')}</label><input id="c-vend" type="datetime-local"></div>
          </div>
          <div class="row2">
            <div><label for="c-scale">${t('scale_max')}</label><input id="c-scale" type="number" min="2" max="100" value="10"></div>
            <div><label for="c-cap">${t('participant_cap')}</label><input id="c-cap" type="number" min="1"></div>
          </div>
          <label><input type="checkbox" id="c-blind" style="width:auto"> ${t('blind_voting')}</label>

          <h3 class="mt">${t('criteria')}</h3>
          <div class="criteria-editor" id="criteria-editor"></div>
          <button type="button" class="btn small secondary" id="add-criterion">+ ${t('add_criterion')}</button>
          <p class="sum-indicator" id="sum-indicator" aria-live="polite"></p>

          <h3>${t('prizes')}</h3>
          <div id="prizes-editor"></div>
          <button type="button" class="btn small secondary" id="add-prize">+ ${t('add_prize')}</button>
        </div>
        <div class="mt"><button class="btn" type="submit">${t('create')}</button></div>
      </form>
    </div>`;

  let kind = 'race';
  const setKind = (value) => {
    kind = value;
    document.getElementById('kind-race').setAttribute('aria-selected', String(value === 'race'));
    document.getElementById('kind-voting').setAttribute('aria-selected', String(value === 'voting'));
    document.getElementById('voting-only').hidden = value === 'race';
    document.getElementById('voting-cat').hidden = value === 'race';
    document.getElementById('voting-mode-box').hidden = value === 'race';
    document.getElementById('race-only').hidden = value !== 'race';
  };
  document.getElementById('kind-race').onclick = () => setKind('race');
  document.getElementById('kind-voting').onclick = () => setKind('voting');

  const editor = document.getElementById('criteria-editor');
  const addCriterion = (name = '', weight = '') => {
    const line = document.createElement('div');
    line.className = 'crit-line';
    line.innerHTML = `
      <input class="crit-name" placeholder="${t('criterion_name')}" value="${esc(name)}" required>
      <input class="crit-weight" type="number" min="1" max="100" placeholder="%" value="${esc(weight)}" required aria-label="${t('weight')}">
      <button type="button" class="ghost crit-del" aria-label="remove">✕</button>`;
    line.querySelector('.crit-del').onclick = () => { line.remove(); updateSum(); };
    line.querySelector('.crit-weight').oninput = updateSum;
    editor.appendChild(line);
    updateSum();
  };
  const updateSum = () => {
    const sum = [...editor.querySelectorAll('.crit-weight')].reduce((s, i) => s + (Number(i.value) || 0), 0);
    const el = document.getElementById('sum-indicator');
    el.textContent = t('weights_sum', { n: sum });
    el.className = `sum-indicator ${sum === 100 ? 'good' : 'bad'}`;
  };
  document.getElementById('add-criterion').onclick = () => addCriterion();
  addCriterion('Creativity', 40); addCriterion('Technical quality', 35); addCriterion('Theme adherence', 25);

  const prizesEditor = document.getElementById('prizes-editor');
  document.getElementById('add-prize').onclick = () => {
    const line = document.createElement('div');
    line.className = 'crit-line';
    line.innerHTML = `
      <input class="prize-name" placeholder="${t('prize_name')}">
      <input class="prize-rank" type="number" min="1" value="${prizesEditor.children.length + 1}" aria-label="${t('prize_rank')}">
      <button type="button" class="ghost prize-del" aria-label="remove">✕</button>`;
    line.querySelector('.prize-del').onclick = () => line.remove();
    prizesEditor.appendChild(line);
  };

  document.getElementById('c-mode').onchange = (e) => {
    document.getElementById('vote-window').hidden = e.target.value !== 'closed';
  };
  setKind('race');

  document.getElementById('create-form').onsubmit = async (e) => {
    e.preventDefault();
    const criteria = [...editor.querySelectorAll('.crit-line')].map((line) => ({
      name: line.querySelector('.crit-name').value,
      weight: Number(line.querySelector('.crit-weight').value),
    }));
    const prizes = [...prizesEditor.querySelectorAll('.crit-line')]
      .map((line) => ({ name: line.querySelector('.prize-name').value, rank: Number(line.querySelector('.prize-rank').value), type: 'badge' }))
      .filter((p) => p.name);
    const body = {
      kind,
      sport: document.getElementById('c-sport').value,
      location: document.getElementById('c-location').value,
      title: document.getElementById('c-title').value,
      description: document.getElementById('c-desc').value,
      category: kind === 'race' ? 'other' : document.getElementById('c-cat').value,
      tags: document.getElementById('c-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
      visibility: document.getElementById('c-visibility').value,
      voting_mode: document.getElementById('c-mode').value,
      blind_voting: document.getElementById('c-blind').checked,
      scale_max: Number(document.getElementById('c-scale').value) || 10,
      participant_cap: Number(document.getElementById('c-cap').value) || undefined,
      start_at: new Date(document.getElementById('c-start').value).toISOString(),
      end_at: new Date(document.getElementById('c-end').value).toISOString(),
      voting_start_at: document.getElementById('c-vstart').value ? new Date(document.getElementById('c-vstart').value).toISOString() : undefined,
      voting_end_at: document.getElementById('c-vend').value ? new Date(document.getElementById('c-vend').value).toISOString() : undefined,
      criteria: kind === 'race' ? [] : criteria,
      prizes: kind === 'race' ? [] : prizes,
    };
    try {
      const contest = await api('/contests', { method: 'POST', body });
      location.hash = `#/contest/${contest.id}`;
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- contest page ----------

let renderGeneration = 0;

async function viewContest(id, tab) {
  const generation = ++renderGeneration;
  const c = await api(`/contests/${id}`);
  if (generation !== renderGeneration) return; // a newer render superseded this one
  const tabs = c.kind === 'race'
    ? ['results', 'startlist', 'details']
    : ['details', 'entries', 'vote', 'leaderboard', 'comments'];
  if (c.is_organizer) tabs.push('timing');
  if (!tabs.includes(tab)) tab = c.kind === 'race' ? 'results' : 'details';
  main.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:start;flex-wrap:wrap">
      <div>
        <h1 style="margin:0 0 4px">${esc(c.title)}</h1>
        <div class="muted">
          ${c.kind === 'race'
            ? `<span class="pill">🏁 ${esc(c.sport) || t('race_kind')}</span>
               ${c.location ? `<span class="pill tag">📍 ${esc(c.location)}</span>` : ''}
               <span class="pill ${c.status === 'finished' ? 'finished' : 'live'}">
                 ${c.status === 'finished' ? t('status_finished') : '● ' + t('hero_live')}
               </span>`
            : `<span class="pill">${t('category_' + c.category)}</span>
               <span class="pill ${c.status === 'finished' ? 'finished' : c.voting_open ? 'live' : ''}">
                 ${c.status === 'finished' ? t('status_finished') : c.voting_open ? t('voting_open_now') : t('status_active')}
               </span>`}
          ${t('by')} <a href="#/profile/${c.organizer.id}">${esc(c.organizer.name)}</a>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${state.user ? `<button class="btn small secondary" id="follow-btn">${c.is_following ? t('unfollow') : t('follow')}</button>` : ''}
        ${state.user && c.status === 'active' && c.kind !== 'race' ? `<button class="btn small" id="join-btn">${t('join')}</button>` : ''}
        ${c.is_organizer && c.status === 'active' ? `<button class="btn small danger" id="finish-btn">${t('finish_contest')}</button>` : ''}
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
  const joinBtn = document.getElementById('join-btn');
  if (joinBtn) joinBtn.onclick = async () => {
    try { await api(`/contests/${id}/join`, { method: 'POST', body: {} }); toast(t('joined')); }
    catch (err) { toast(err.message, true); }
  };
  const finishBtn = document.getElementById('finish-btn');
  if (finishBtn) finishBtn.onclick = async () => {
    if (!confirm(t('finish_contest') + '?')) return;
    try { await api(`/contests/${id}/finish`, { method: 'POST', body: {} }); viewContest(id, 'leaderboard'); }
    catch (err) { toast(err.message, true); }
  };

  const box = document.getElementById('tab-content');
  if (tab === 'results') renderRaceResults(box, c);
  else if (tab === 'startlist') renderStartlist(box, c);
  else if (tab === 'details') renderDetails(box, c);
  else if (tab === 'entries') renderEntries(box, c, false);
  else if (tab === 'vote') renderEntries(box, c, true);
  else if (tab === 'leaderboard') renderLeaderboard(box, c);
  else if (tab === 'comments') renderContestComments(box, c);
  else if (tab === 'timing') renderTiming(box, c);
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
          ${c.voting_mode === 'closed' ? `<li><span>${t('voting_window')}</span><strong>${fmtDate(c.voting_start_at)} → ${fmtDate(c.voting_end_at)}</strong></li>` : ''}
          <li><span>${t('visibility')}</span><strong>${t(c.visibility)}</strong></li>
          <li><span>${t('blind_voting')}</span><strong>${c.blind_voting ? t('on') : t('off')}</strong></li>
          <li><span>${t('entries')}</span><strong>${c.entry_count}</strong></li>
          <li><span>${t('voters')}</span><strong>${c.voter_count}</strong></li>
          ${c.invite_code ? `<li><span>${t('invite_code')}</span><strong><code>${esc(c.invite_code)}</code></strong></li>` : ''}
        </ul>
        ${state.user && c.status === 'active' ? `<div class="mt"><a class="btn" href="#/contest/${c.id}/entries">${t('submit_entry')}</a></div>` : ''}
      </div>
    </div>`;
}

// ---------- entries & voting ----------

async function renderEntries(box, c, votingMode) {
  const { entries } = await api(`/contests/${c.id}/entries`);
  const canSubmit = state.user && c.status === 'active' && !votingMode;
  box.innerHTML = `
    ${canSubmit ? `<div class="card" id="submit-card">${submitFormHtml()}</div>` : ''}
    <div class="grid mt" id="entries-grid">
      ${entries.length ? '' : `<p class="muted">${t('no_entries')}</p>`}
    </div>`;

  if (canSubmit) wireSubmitForm(c);

  const grid = document.getElementById('entries-grid');
  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'card entry-card';
    card.innerHTML = entryCardHtml(entry, c, votingMode);
    grid.appendChild(card);
    wireEntryCard(card, entry, c, votingMode);
  }
}

function entryMediaHtml(e) {
  if (e.kind === 'image' && e.file_url) return `<img class="thumb" src="${BASE}${esc(e.file_url)}" alt="${esc(e.title)}">`;
  if (e.kind === 'video' && e.file_url) return `<video controls preload="metadata" src="${BASE}${esc(e.file_url)}"></video>`;
  if (e.kind === 'pdf' && e.file_url) return `<a class="btn small secondary" href="${BASE}${esc(e.file_url)}" target="_blank" rel="noopener">📄 PDF</a>`;
  if (e.kind === 'code') return `<pre><code>${esc(e.body.slice(0, 1200))}</code></pre>`;
  return e.body ? `<p style="white-space:pre-wrap">${esc(e.body.slice(0, 500))}${e.body.length > 500 ? '…' : ''}</p>` : '';
}

function entryCardHtml(e, c, votingMode) {
  const own = state.user && e.user_id === state.user.id;
  return `
    <div class="entry-head">
      ${avatar(e.author.avatar_url, e.author.name)}
      <div>
        <strong>${esc(e.title)}</strong><br>
        <span class="muted" style="font-size:0.85rem">${t('by')} ${e.author.id ? `<a href="#/profile/${e.author.id}">${esc(e.author.name)}</a>` : esc(e.author.name)}</span>
      </div>
      <span class="score-big" style="margin-inline-start:auto" title="${t('score')}">${e.score}</span>
    </div>
    ${entryMediaHtml(e)}
    ${e.description ? `<p class="muted" style="margin:0">${esc(e.description.slice(0, 200))}</p>` : ''}
    <div class="meta muted" style="font-size:0.85rem">
      ⭐ ${e.vote_count} ${t('votes')} · 💬 ${e.comment_count} · ${(e.tags || []).map((tag) => `#${esc(tag)}`).join(' ')}
    </div>
    ${votingMode ? voteWidgetHtml(e, c, own) : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${!votingMode && c.voting_open ? `<a class="btn small" href="#/contest/${c.id}/vote">${t('vote_for')}</a>` : ''}
      <button class="btn small secondary comments-btn">💬 ${t('comments')}</button>
      ${state.user ? `<button class="btn small secondary report-btn">🚩 ${t('report')}</button>` : ''}
    </div>
    <div class="comments-box" hidden></div>`;
}

function voteWidgetHtml(e, c, own) {
  if (own) return `<p class="muted">${t('cannot_vote_own')}</p>`;
  if (!state.user) return `<p class="muted"><a href="#/login">${t('login_to_vote')}</a></p>`;
  if (!c.voting_open) return `<p class="muted">${t('voting_closed')}</p>`;
  return `
    <fieldset style="border:1px solid var(--border);border-radius:8px">
      <legend style="font-weight:700">${t('vote_for')}</legend>
      ${c.criteria.map((cr) => {
        const prev = e.my_votes && e.my_votes[cr.id] !== undefined ? e.my_votes[cr.id] : Math.round(c.scale_max / 2);
        return `
          <div class="criterion-row">
            <label style="margin:0" for="v-${e.id}-${cr.id}">${esc(cr.name)} <span class="muted">(${cr.weight}%)</span></label>
            <input type="range" id="v-${e.id}-${cr.id}" data-crit="${cr.id}" data-weight="${cr.weight}"
              min="0" max="${c.scale_max}" step="1" value="${prev}"
              aria-label="${esc(cr.name)}" aria-valuemin="0" aria-valuemax="${c.scale_max}">
            <output for="v-${e.id}-${cr.id}">${prev}</output>
          </div>`;
      }).join('')}
      <div style="display:flex;align-items:center;gap:12px;margin-top:8px">
        <span>${t('weighted_total')}: <span class="weighted-preview" data-preview>–</span> / ${c.scale_max}</span>
        <button class="btn small vote-submit">${t('confirm_vote')}</button>
      </div>
    </fieldset>`;
}

function wireEntryCard(card, entry, c, votingMode) {
  const commentsBtn = card.querySelector('.comments-btn');
  const commentsBox = card.querySelector('.comments-box');
  commentsBtn.onclick = async () => {
    commentsBox.hidden = !commentsBox.hidden;
    if (!commentsBox.hidden) loadComments(commentsBox, entry);
  };
  const reportBtn = card.querySelector('.report-btn');
  if (reportBtn) reportBtn.onclick = async () => {
    const reason = prompt(t('report_reason'));
    if (!reason) return;
    try { await api('/reports', { method: 'POST', body: { target_type: 'entry', target_id: entry.id, reason } }); toast('✓'); }
    catch (err) { toast(err.message, true); }
  };

  if (votingMode) {
    const sliders = [...card.querySelectorAll('input[type="range"]')];
    const preview = card.querySelector('[data-preview]');
    const update = () => {
      if (!preview) return;
      const total = sliders.reduce((s, sl) => s + (Number(sl.dataset.weight) / 100) * Number(sl.value), 0);
      preview.textContent = (Math.round(total * 100) / 100).toFixed(2);
      sliders.forEach((sl) => { sl.nextElementSibling.textContent = sl.value; });
    };
    sliders.forEach((sl) => sl.addEventListener('input', update));
    update();
    const submitBtn = card.querySelector('.vote-submit');
    if (submitBtn) submitBtn.onclick = async () => {
      const scores = {};
      sliders.forEach((sl) => { scores[sl.dataset.crit] = Number(sl.value); });
      try {
        const r = await api(`/entries/${entry.id}/vote`, { method: 'POST', body: { scores } });
        toast(`${t('vote_saved')} (${r.entry_score})`);
      } catch (err) { toast(err.message, true); }
    };
  }
}

async function loadComments(box, entry) {
  const { comments } = await api(`/entries/${entry.id}/comments`);
  box.innerHTML = `
    ${state.user ? `
      <form class="comment-form" style="display:flex;gap:8px;margin:8px 0">
        <input name="body" placeholder="${t('add_comment')}" aria-label="${t('add_comment')}" required>
        <button class="btn small">${t('post')}</button>
      </form>` : ''}
    <div class="comment-list">
      ${comments.map((cm) => `
        <div class="comment">
          <div class="who">${avatar(cm.avatar_url, cm.name)} ${esc(cm.name)} <time>${fmtDate(cm.created_at)}</time>
            ${state.user ? `<button class="ghost report-comment" data-id="${cm.id}" aria-label="${t('report')}" style="font-size:0.8rem">🚩</button>` : ''}
          </div>
          <div>${esc(cm.body)}</div>
        </div>`).join('')}
    </div>`;
  const form = box.querySelector('.comment-form');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/entries/${entry.id}/comments`, { method: 'POST', body: { body: form.body.value } });
      loadComments(box, entry);
    } catch (err) { toast(err.message, true); }
  };
  box.querySelectorAll('.report-comment').forEach((btn) => {
    btn.onclick = async () => {
      const reason = prompt(t('report_reason'));
      if (!reason) return;
      try { await api('/reports', { method: 'POST', body: { target_type: 'comment', target_id: Number(btn.dataset.id), reason } }); toast('✓'); }
      catch (err) { toast(err.message, true); }
    };
  });
}

function submitFormHtml() {
  return `
    <h3 style="margin-top:0">${t('submit_entry')}</h3>
    <form id="entry-form">
      <label for="e-title">${t('entry_title')}</label>
      <input id="e-title" required maxlength="120">
      <label for="e-desc">${t('description')}</label>
      <input id="e-desc" maxlength="300">
      <label for="e-tags">${t('tags')}</label>
      <input id="e-tags">
      <div class="row2">
        <div>
          <label for="e-kind">${t('content_text')} / ${t('content_code')}</label>
          <select id="e-kind"><option value="text">${t('content_text')}</option><option value="code">${t('content_code')}</option></select>
        </div>
        <div>
          <label for="e-file">${t('upload_file')}</label>
          <input id="e-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,application/pdf">
        </div>
      </div>
      <label for="e-body">${t('content_text')}</label>
      <textarea id="e-body" rows="5" spellcheck="false"></textarea>
      <div id="e-preview" class="mt" aria-live="polite"></div>
      <button class="btn mt" type="submit">${t('submit')}</button>
    </form>`;
}

function wireSubmitForm(c) {
  const file = document.getElementById('e-file');
  const preview = document.getElementById('e-preview');
  file.onchange = () => {
    preview.innerHTML = '';
    const f = file.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    if (f.type.startsWith('image/')) preview.innerHTML = `<p class="muted">${t('preview')}:</p><img src="${url}" alt="" style="max-width:280px;border-radius:8px">`;
    else if (f.type.startsWith('video/')) preview.innerHTML = `<p class="muted">${t('preview')}:</p><video controls src="${url}" style="max-width:280px"></video>`;
    else preview.innerHTML = `<p class="muted">📄 ${esc(f.name)} (${Math.round(f.size / 1024)} KB)</p>`;
  };
  document.getElementById('entry-form').onsubmit = async (e) => {
    e.preventDefault();
    const form = new FormData();
    form.set('title', document.getElementById('e-title').value);
    form.set('description', document.getElementById('e-desc').value);
    form.set('tags', document.getElementById('e-tags').value);
    form.set('kind', document.getElementById('e-kind').value);
    form.set('body', document.getElementById('e-body').value);
    if (file.files[0]) form.set('file', file.files[0]);
    try {
      const r = await api(`/contests/${c.id}/entries`, { method: 'POST', form });
      if (r.moderation && r.moderation !== 'ok') toast(r.moderation, true);
      viewContest(c.id, 'entries');
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- leaderboard (live via SSE) ----------

async function renderLeaderboard(box, c) {
  box.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <span class="live-indicator" id="live-indicator">● ${t('live')} — <span id="updated-ago">${t('updated_ago', { s: 0 })}</span></span>
        <a class="btn small secondary" href="${BASE}/api/contests/${c.id}/leaderboard?format=csv" download>⬇ ${t('export_csv')}</a>
      </div>
      <div style="overflow-x:auto">
        <table class="board" id="board">
          <thead><tr>
            <th>${t('rank')}</th><th>${t('entry')}</th><th>${t('author')}</th>
            <th>${t('score')}</th><th>${t('pct_of_max')}</th><th>${t('votes')}</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <h3>${t('score_history')}</h3>
      <div id="chart-box"></div>
    </div>`;

  let lastUpdate = Date.now();
  const drawBoard = (board, awards = []) => {
    const tbody = box.querySelector('#board tbody');
    const prevRanks = new Map([...tbody.querySelectorAll('tr')].map((tr) => [tr.dataset.entry, tr.rowIndex]));
    tbody.innerHTML = board.map((r) => `
      <tr data-entry="${r.entry_id}" class="${r.rank <= 3 ? 'top' + r.rank : ''}">
        <td><span class="rank-medal">${MEDALS[r.rank] || r.rank}</span>
          ${awards.find((a) => a.entry_id === r.entry_id) ? `<span class="pill live">${t('winner')}</span>` : ''}</td>
        <td>${esc(r.title)}</td>
        <td>${r.user_id ? `<a href="#/profile/${r.user_id}">${esc(r.author_name)}</a>` : esc(r.author_name)}</td>
        <td><strong>${r.score}</strong></td>
        <td><div class="bar" title="${r.pct_of_max}%"><div style="width:${Math.min(100, r.pct_of_max)}%"></div></div> ${r.pct_of_max}%</td>
        <td>${r.votes}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="muted">${t('no_votes_yet')}</td></tr>`;
    tbody.querySelectorAll('tr').forEach((tr) => {
      const prev = prevRanks.get(tr.dataset.entry);
      if (prev !== undefined && prev !== tr.rowIndex) {
        tr.classList.add('flash');
        setTimeout(() => tr.classList.remove('flash'), 1200);
      }
    });
    lastUpdate = Date.now();
  };

  const data = await api(`/contests/${c.id}/leaderboard`);
  drawBoard(data.leaderboard, data.awards);
  drawHistoryChart(c);

  const agoTimer = setInterval(() => {
    const el = document.getElementById('updated-ago');
    if (!el) return clearInterval(agoTimer);
    el.textContent = t('updated_ago', { s: Math.round((Date.now() - lastUpdate) / 1000) });
  }, 1000);

  closeSse();
  state.sse = new EventSource(`${BASE}/api/contests/${c.id}/stream`);
  state.sse.addEventListener('leaderboard', (ev) => {
    const payload = JSON.parse(ev.data);
    drawBoard(payload.leaderboard, data.awards);
    drawHistoryChart(c);
  });
}

async function drawHistoryChart(c) {
  const boxEl = document.getElementById('chart-box');
  if (!boxEl) return;
  const { history } = await api(`/contests/${c.id}/history`);
  if (!history.length) { boxEl.innerHTML = `<p class="muted">${t('no_votes_yet')}</p>`; return; }
  const byEntry = new Map();
  history.forEach((h, i) => {
    if (!byEntry.has(h.entry_id)) byEntry.set(h.entry_id, { title: h.title, points: [] });
    byEntry.get(h.entry_id).points.push({ x: i, y: h.score });
  });
  const W = 700, H = 180, maxX = history.length - 1 || 1;
  const maxY = Math.max(...history.map((h) => h.score), 1);
  const colors = ['#2f5cff', '#ff8a3d', '#1d9d63', '#d3364a', '#8b5cf6', '#0ea5e9'];
  let k = 0;
  const lines = [...byEntry.values()].map((s) => {
    const pts = s.points.map((p) => `${(p.x / maxX) * W},${H - (p.y / maxY) * (H - 10)}`).join(' ');
    const color = colors[k++ % colors.length];
    return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"><title>${esc(s.title)}</title></polyline>`;
  }).join('');
  const legend = [...byEntry.values()].map((s, i) =>
    `<span style="color:${colors[i % colors.length]};font-weight:700;font-size:0.8rem">— ${esc(s.title)}</span>`).join(' ');
  boxEl.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('score_history')}">${lines}</svg><div>${legend}</div>`;
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
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('category')}</th>
          <th>${t('category_place')}</th><th>${t('wave')}</th><th>${t('laps')}</th><th>${t('elapsed_col')}</th><th>${t('behind')}</th>
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
          <td>${esc(r.wave || '')}</td>
          <td>${r.laps || ''}</td>
          <td class="muted">${RACE_STATUS_LABEL()[r.status] || r.status}</td>
          <td></td>
        </tr>`),
    ].join('') || `<tr><td colspan="9" class="muted">${t('no_results_yet')}</td></tr>`;
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

async function renderStartlist(box, c) {
  const { racers, waves } = await api(`/contests/${c.id}/startlist`);
  box.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">${t('tab_startlist')} <span class="muted" style="font-weight:400">(${racers.length} ${t('racers_count')})</span></h3>
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('bib')}</th><th>${t('participant')}</th><th>${t('category')}</th><th>${t('wave')}</th><th>${t('racer_status')}</th>
        </tr></thead><tbody>
          ${racers.map((r) => `
            <tr>
              <td><strong>${esc(r.bib || '')}</strong></td>
              <td>${esc(r.participant)}</td>
              <td>${esc(r.category || '')}</td>
              <td>${esc(r.wave || '')}</td>
              <td>${r.racer_status ? `<span class="pill finished">${esc(r.racer_status)}</span>` : ''}</td>
            </tr>`).join('') || `<tr><td colspan="5" class="muted">${t('no_startlist')}</td></tr>`}
        </tbody></table>
      </div>
      ${waves.length ? `<p class="muted">${waves.map((w) => `${esc(w.name)}: ${w.started_at ? fmtDate(w.started_at) : t('not_started')}`).join(' · ')}</p>` : ''}
    </div>`;
}

// CSV start list: header row optional; recognizes bib/name/category/wave/epc
// column names in English and Hebrew, or positional columns in that order.
function parseStartListCsv(text) {
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    text.split('\n')[0].split(d).length > text.split('\n')[0].split(best).length ? d : best, ',');
  const parseLine = (line) => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delimiter) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((s) => s.trim());
  };
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const HEADER_MAP = {
    bib: ['bib', 'number', 'num', '#', 'מספר', 'מספר חזה', 'חזה'],
    participant: ['name', 'participant', 'racer', 'שם', 'שם מלא'],
    category: ['category', 'cat', 'קטגוריה'],
    wave: ['wave', 'heat', 'מקצה'],
    epc: ['epc', 'chip', 'tag', 'chip id', 'שבב', 'תג'],
  };
  const first = parseLine(lines[0]).map((h) => h.toLowerCase());
  const cols = {};
  let hasHeader = false;
  for (const [field, names] of Object.entries(HEADER_MAP)) {
    const idx = first.findIndex((h) => names.includes(h));
    if (idx >= 0) { cols[field] = idx; hasHeader = true; }
  }
  if (!hasHeader) {
    // positional: bib, name, category, wave, epc
    Object.assign(cols, { bib: 0, participant: 1, category: 2, wave: 3, epc: 4 });
  }
  return lines.slice(hasHeader ? 1 : 0).map(parseLine).map((cells) => ({
    bib: cells[cols.bib] ?? '',
    participant: cells[cols.participant] ?? '',
    category: cols.category !== undefined ? cells[cols.category] ?? '' : '',
    wave: cols.wave !== undefined ? cells[cols.wave] ?? '' : '',
    epc: cols.epc !== undefined ? cells[cols.epc] ?? '' : '',
  })).filter((r) => r.participant || r.bib);
}

// ---------- timing tab: RFID readers, live reads, tag assignment ----------

async function renderTiming(box, c) {
  const generation = renderGeneration;
  const [{ readers }, { tags }, wavesData] = await Promise.all([
    api(`/contests/${c.id}/readers`),
    api(`/contests/${c.id}/tags`),
    api(`/contests/${c.id}/waves`),
  ]);
  if (generation !== renderGeneration) return; // superseded while fetching
  const waves = wavesData.waves;
  const $ = (sel) => box.querySelector(sel);
  box.innerHTML = `
    <p class="muted">${t('timing_help')}</p>
    <div class="detail-grid">
      <div class="card">
        <h3 style="margin-top:0">${t('readers')}</h3>
        <div id="readers-list">
          ${readers.map((r) => `
            <div class="comment" data-reader="${r.id}">
              <div class="who">📡 ${esc(r.name)} ${r.location ? `<span class="pill">${esc(r.location)}</span>` : ''}
                <span class="muted" style="font-weight:400">· ${r.read_count} ${t('reads')} · ${t('last_seen')}: ${r.last_seen ? fmtDate(r.last_seen) : t('never')}</span>
                <button class="ghost reader-del" data-id="${r.id}" aria-label="${t('delete')}" style="margin-inline-start:auto">🗑</button>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <code style="font-size:0.75rem;overflow-wrap:anywhere">${esc(r.token)}</code>
                <button class="btn small secondary copy-token" data-token="${esc(r.token)}">${t('copy')}</button>
              </div>
            </div>`).join('') || `<p class="muted">—</p>`}
        </div>
        <form id="reader-form" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <input name="name" placeholder="${t('reader_name')}" required style="flex:1;min-width:130px">
          <input name="location" placeholder="${t('reader_location')}" style="flex:1;min-width:130px">
          <button class="btn small">+ ${t('add_reader')}</button>
        </form>
      </div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <h3 style="margin-top:0">${t('tag_assignments')}</h3>
          <div>
            <input type="file" id="csv-file" accept=".csv,text/csv" hidden>
            <button class="btn small secondary" id="import-csv" title="${t('csv_help')}">⬆ ${t('import_csv')}</button>
          </div>
        </div>
        <p class="muted" style="font-size:0.78rem;margin:2px 0 8px">${t('csv_help')}</p>
        <form id="tag-form" style="display:flex;gap:6px;flex-wrap:wrap">
          <input name="epc" placeholder="${t('epc')}" required pattern="[0-9A-Fa-f]{4,64}" style="flex:2;min-width:120px">
          <input name="bib" placeholder="${t('bib')}" style="width:70px">
          <input name="participant" placeholder="${t('participant')}" required style="flex:2;min-width:110px">
          <input name="category" placeholder="${t('category')}" style="flex:1;min-width:80px">
          <select name="wave_id" aria-label="${t('wave')}" style="flex:1;min-width:90px">
            <option value="">${t('wave')} —</option>
            ${waves.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
          </select>
          <button class="btn small">${t('assign')}</button>
        </form>
        <div id="tags-list" class="mt" style="max-height:220px;overflow:auto">
          ${tags.map((a, i) => `
            <div class="comment" style="display:flex;gap:8px;align-items:center">
              <strong>#${esc(a.bib || '—')}</strong> ${esc(a.participant)}
              ${a.category ? `<span class="pill tag">${esc(a.category)}</span>` : ''}
              ${a.wave_name ? `<span class="pill">${esc(a.wave_name)}</span>` : ''}
              <code style="font-size:0.7rem;overflow-wrap:anywhere">${esc(a.epc)}</code>
              <select class="tag-status" data-idx="${i}" aria-label="${t('racer_status')}" style="width:auto;margin-inline-start:auto;padding:2px 6px">
                ${['', 'DNS', 'DNF', 'DSQ'].map((s) => `<option value="${s}" ${a.racer_status === s ? 'selected' : ''}>${s || t('status_ok')}</option>`).join('')}
              </select>
              <button class="ghost tag-del" data-epc="${esc(a.epc)}" aria-label="${t('delete')}">🗑</button>
            </div>`).join('') || `<p class="muted">—</p>`}
        </div>
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
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('wave')}</th><th>${t('participant')}</th><th>${t('started_at')}</th><th>${t('race_clock')}</th><th></th>
        </tr></thead><tbody id="waves-body">
          ${waves.map((w) => `
            <tr data-wave="${w.id}" data-started="${w.started_at || ''}">
              <td><strong>${esc(w.name)}</strong></td>
              <td>${w.racer_count}</td>
              <td>${w.started_at ? fmtDate(w.started_at) : `<span class="muted">${t('not_started')}</span>`}</td>
              <td class="wave-clock" style="font-weight:700;font-variant-numeric:tabular-nums">—</td>
              <td style="display:flex;gap:6px">
                <button class="btn small ${w.started_at ? 'secondary' : ''} wave-start" data-id="${w.id}" data-started="${w.started_at ? 1 : 0}">▶ ${t('start_wave')}</button>
                <button class="ghost wave-del" data-id="${w.id}" aria-label="${t('delete')}">🗑</button>
              </td>
            </tr>`).join('')}
        </tbody></table>
      </div>
      <form id="wave-form" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <input name="name" placeholder="${t('wave')}" required style="max-width:220px">
        <button class="btn small">+ ${t('add_wave')}</button>
      </form>
    </div>

    <div class="card mt">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${t('race_results')} <span class="live-indicator">● ${t('live')}</span></h3>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <form id="manual-form" style="display:flex;gap:6px">
            <input name="bib" placeholder="${t('manual_entry')}" pattern="[0-9A-Za-z\\-]+" required style="width:160px">
            <button class="btn small">⏱ ${t('record')}</button>
          </form>
          <a class="btn small secondary" href="#" id="results-csv">⬇ ${t('export_csv')}</a>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('rank')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('category')}</th>
          <th>${t('wave')}</th><th>${t('laps')}</th><th>${t('elapsed_col')}</th><th>${t('status_col')}</th>
        </tr></thead><tbody id="results-body"></tbody></table>
      </div>
    </div>

    <div class="card mt">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${t('live_reads')} <span class="live-indicator">● ${t('live')}</span></h3>
        <a class="btn small secondary" href="${BASE}/api/contests/${c.id}/reads?format=csv" id="reads-csv">⬇ ${t('export_csv')}</a>
      </div>
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('last_read')}</th><th>${t('epc')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('reader_col')}</th><th>RSSI</th>
        </tr></thead><tbody id="reads-body"></tbody></table>
      </div>
      <h3>${t('passings')}</h3>
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('epc')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('passes')}</th><th>${t('first_read')}</th><th>${t('last_read')}</th><th>${t('elapsed')}</th>
        </tr></thead><tbody id="passings-body"></tbody></table>
      </div>
    </div>`;

  // CSV link needs the auth token — fetch and download via blob instead.
  $('#reads-csv').onclick = async (e) => {
    e.preventDefault();
    const res = await fetch(`${BASE}/api/contests/${c.id}/reads?format=csv`, { headers: { Authorization: `Bearer ${state.token}` } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reads-${c.id}.csv`;
    a.click();
  };

  $('#reader-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/contests/${c.id}/readers`, { method: 'POST', body: { name: e.target.name.value, location: e.target.location.value } });
      viewContest(c.id, 'timing');
    } catch (err) { toast(err.message, true); }
  };
  box.querySelectorAll('.reader-del').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(t('delete') + '?')) return;
      await api(`/contests/${c.id}/readers/${btn.dataset.id}`, { method: 'DELETE' });
      viewContest(c.id, 'timing');
    };
  });
  box.querySelectorAll('.copy-token').forEach((btn) => {
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(btn.dataset.token); toast(t('copied')); }
      catch { prompt(t('copy'), btn.dataset.token); }
    };
  });
  $('#tag-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/contests/${c.id}/tags`, { method: 'POST', body: {
        epc: e.target.epc.value, bib: e.target.bib.value, participant: e.target.participant.value,
        category: e.target.category.value, wave_id: e.target.wave_id.value ? Number(e.target.wave_id.value) : null,
      }});
      viewContest(c.id, 'timing');
    } catch (err) { toast(err.message, true); }
  };
  box.querySelectorAll('.tag-del').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/contests/${c.id}/tags/${btn.dataset.epc}`, { method: 'DELETE' });
      viewContest(c.id, 'timing');
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

  // ---- CSV start-list import ----
  const csvFile = $('#csv-file');
  $('#import-csv').onclick = () => csvFile.click();
  csvFile.onchange = async () => {
    const file = csvFile.files[0];
    if (!file) return;
    try {
      const text = (await file.text()).replace(/^\uFEFF/, ''); // strip Excel BOM
      const racers = parseStartListCsv(text);
      if (!racers.length) throw new Error(t('csv_help'));
      const result = await api(`/contests/${c.id}/tags/bulk`, { method: 'POST', body: { racers } });
      toast(t('import_done', { n: result.imported, s: result.skipped })
        + (result.errors.length ? ' — ' + result.errors[0] : ''), result.errors.length > 0);
      viewContest(c.id, 'timing');
    } catch (err) { toast(err.message, true); }
    csvFile.value = '';
  };

  // ---- waves & race start ----
  $('#wave-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/contests/${c.id}/waves`, { method: 'POST', body: { name: e.target.name.value } });
      viewContest(c.id, 'timing');
    } catch (err) { toast(err.message, true); }
  };
  box.querySelectorAll('.wave-start').forEach((btn) => {
    btn.onclick = async () => {
      const restart = btn.dataset.started === '1';
      if (restart && !confirm(t('restart_wave_confirm'))) return;
      try {
        await api(`/contests/${c.id}/waves/${btn.dataset.id}/start`, { method: 'POST', body: restart ? { force: true } : {} });
        viewContest(c.id, 'timing');
      } catch (err) { toast(err.message, true); }
    };
  });
  box.querySelectorAll('.wave-del').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(t('delete') + '?')) return;
      await api(`/contests/${c.id}/waves/${btn.dataset.id}`, { method: 'DELETE' });
      viewContest(c.id, 'timing');
    };
  });
  $('#timing-settings').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/contests/${c.id}/timing-settings`, { method: 'PATCH', body: {
        suppress_secs: Number(e.target.suppress.value), min_lap_gap_secs: Number(e.target.lapgap.value),
      }});
      toast('✓');
      refreshResults();
    } catch (err) { toast(err.message, true); }
  };
  $('#manual-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/contests/${c.id}/manual-read`, { method: 'POST', body: { bib: e.target.bib.value } });
      e.target.bib.value = '';
      toast('⏱ ✓');
    } catch (err) { toast(err.message, true); }
  };
  $('#results-csv').onclick = async (e) => {
    e.preventDefault();
    const res = await fetch(`${BASE}/api/contests/${c.id}/race-results?format=csv`, { headers: { Authorization: `Bearer ${state.token}` } });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = `race-results-${c.id}.csv`;
    a.click();
  };

  // per-wave race clocks tick every second
  const clockTimer = setInterval(() => {
    const rows = box.querySelectorAll('#waves-body tr');
    if (!rows.length) return clearInterval(clockTimer);
    rows.forEach((tr) => {
      const started = tr.dataset.started;
      if (!started) return;
      const secs = Math.max(0, Math.floor((Date.now() - Date.parse(started)) / 1000));
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
      tr.querySelector('.wave-clock').textContent =
        `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    });
  }, 1000);

  const STATUS_LABEL = { finished: t('status_finished_r'), on_course: t('status_on_course'), not_started: t('status_not_started') };
  async function refreshResults() {
    const { results } = await api(`/contests/${c.id}/race-results`);
    const body = $('#results-body');
    if (!body) return;
    body.innerHTML = results.map((r) => `
      <tr class="${r.rank <= 3 ? 'top' + r.rank : ''}">
        <td>${r.rank ? MEDALS[r.rank] || r.rank : ''}</td>
        <td><strong>${esc(r.bib || '')}</strong></td>
        <td>${esc(r.participant)}</td>
        <td>${esc(r.category || '')}</td>
        <td>${esc(r.wave || '')}</td>
        <td>${r.laps}</td>
        <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed || '—'}</strong></td>
        <td class="${r.status === 'finished' ? '' : 'muted'}">${STATUS_LABEL[r.status] || r.status}</td>
      </tr>`).join('') || `<tr><td colspan="8" class="muted">—</td></tr>`;
  }
  refreshResults();

  const readRow = (r) => `
    <tr><td>${fmtDate(r.read_at)}</td><td><code style="font-size:0.75rem">${esc(r.epc)}</code></td>
    <td>${esc(r.bib || '')}</td><td>${r.participant ? esc(r.participant) : `<span class="muted">${t('unassigned')}</span>`}</td>
    <td>${esc(r.reader_name || r.reader?.name || '')}</td><td>${r.rssi ?? ''}</td></tr>`;

  const refreshPassings = async () => {
    const { passings } = await api(`/contests/${c.id}/passings`);
    const body = $('#passings-body');
    if (!body) return;
    body.innerHTML = passings.map((p) => `
      <tr><td><code style="font-size:0.75rem">${esc(p.epc)}</code></td><td>${esc(p.bib || '')}</td>
      <td>${p.participant ? esc(p.participant) : `<span class="muted">${t('unassigned')}</span>`}</td>
      <td>${p.passes}</td><td>${fmtDate(p.first_read)}</td><td>${fmtDate(p.last_read)}</td>
      <td>${Math.floor(p.elapsed_seconds / 60)}:${String(p.elapsed_seconds % 60).padStart(2, '0')}</td></tr>`).join('')
      || `<tr><td colspan="7" class="muted">${t('no_reads')}</td></tr>`;
  };

  const { reads } = await api(`/contests/${c.id}/reads?limit=100`);
  const tbody = $('#reads-body');
  tbody.innerHTML = reads.map(readRow).join('') || `<tr><td colspan="6" class="muted">${t('no_reads')}</td></tr>`;
  refreshPassings();

  closeSse();
  state.sse = new EventSource(`${BASE}/api/contests/${c.id}/stream`);
  state.sse.addEventListener('tag_reads', (ev) => {
    const payload = JSON.parse(ev.data);
    const rows = payload.reads.map((r) => readRow({ ...r, reader_name: payload.reader.name })).join('');
    if (reads.length === 0 && tbody.children.length === 1 && tbody.textContent.includes(t('no_reads'))) tbody.innerHTML = '';
    tbody.insertAdjacentHTML('afterbegin', rows);
    while (tbody.children.length > 100) tbody.removeChild(tbody.lastChild);
    refreshPassings();
    refreshResults();
  });
  state.sse.addEventListener('wave_start', () => {
    viewContest(c.id, 'timing');
  });
}

// ---------- contest comments tab (aggregates entry comments) ----------

async function renderContestComments(box, c) {
  const { entries } = await api(`/contests/${c.id}/entries`);
  box.innerHTML = entries.length
    ? entries.map((e) => `
        <div class="card mt">
          <strong>${esc(e.title)}</strong> <span class="muted">(${e.comment_count} 💬)</span>
          <div class="comments-box" data-entry="${e.id}"></div>
        </div>`).join('')
    : `<p class="muted">${t('no_entries')}</p>`;
  box.querySelectorAll('.comments-box').forEach((cb) => {
    const entry = entries.find((e) => e.id === Number(cb.dataset.entry));
    loadComments(cb, entry);
  });
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

setLang(LANG);
renderChrome();
route();

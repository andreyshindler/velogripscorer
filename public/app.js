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

// Drill-in arrow that points in the reading direction (left in Hebrew RTL).
function arrow() { return LANG === 'he' ? '◂' : '▸'; }

// Editing race results is restricted to admin accounts.
function isAdmin() { return !!(state.user && state.user.role === 'admin'); }

// Participant name with the team as a small muted sub-line (shared across the
// results tables so every tab shows the team the same way).
function nameWithTeam(r) {
  return `${esc(r.participant)}${r.team ? `<div class="muted" style="font-size:.78rem">${esc(r.team)}</div>` : ''}`;
}

// Sport is stored as free text (often typed in English, e.g. "Running").
// Translate the common values so cards read in the UI language; anything
// unrecognised falls through unchanged.
const SPORT_KEYS = {
  running: 'sport_running', run: 'sport_running',
  cycling: 'sport_cycling', bike: 'sport_cycling', cycle: 'sport_cycling', biking: 'sport_cycling',
  walking: 'sport_walking', walk: 'sport_walking',
  swimming: 'sport_swimming', swim: 'sport_swimming',
  triathlon: 'sport_triathlon', duathlon: 'sport_duathlon',
  trail: 'sport_trail', 'trail running': 'sport_trail',
  mtb: 'sport_mtb', 'cross-country': 'sport_mtb', 'cross country': 'sport_mtb', xco: 'sport_mtb',
  marathon: 'sport_marathon',
};
// Keyword tokens tried longest-first so a specific one wins (e.g. "trail
// running" before "run"), used to translate free-text sports.
const SPORT_TOKENS = Object.keys(SPORT_KEYS).sort((a, b) => b.length - a.length);
function sportLabel(sport) {
  const raw = String(sport ?? '').trim();
  if (!raw) return t('race_kind');
  const low = raw.toLowerCase();
  if (SPORT_KEYS[low]) return t(SPORT_KEYS[low]); // exact match
  // Free-text values like "MTB — Cross-country (XCO)" — match a known keyword
  // anywhere in the string so bike races read in Hebrew like running does.
  for (const tok of SPORT_TOKENS) if (low.includes(tok)) return t(SPORT_KEYS[tok]);
  return raw;
}

// ISO instant -> value for a <input type="datetime-local"> in the viewer's
// local time (the input has no timezone). new Date(value) reads it back.
function toLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

// Download a file from an authenticated endpoint (sends the Bearer token, which
// a plain <a download> link cannot), then save the blob.
async function downloadAuthed(path, filename) {
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
    });
    if (!res.ok) { toast(t('error_generic'), true); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch { toast(t('error_generic'), true); }
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  // Success uses var(--text) as the pill (dark in light theme, light in dark
  // theme), so the label must be its opposite to stay readable in both.
  el.style.background = isError ? 'var(--danger)' : 'var(--text)';
  el.style.color = isError ? '#fff' : 'var(--bg)';
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
  document.getElementById('footer-api').hidden = !(state.user && state.user.role === 'admin');
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

// Where a notification should take you when clicked, by type/payload.
function notifHref(n) {
  if (n.type === 'registration') return '#/admin/users';        // a sign-up to approve
  if (n.type === 'account_approved') return '#/';               // your account was approved
  if (n.data && n.data.contest_id) return `#/contest/${n.data.contest_id}`;
  return null;
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
        notifications.map((n) => {
          const href = notifHref(n);
          const label = esc(n.message);
          return `<div class="notif ${n.read ? '' : 'unread'}">
            ${href ? `<a href="${href}" class="notif-link">${label}</a>` : label}
            <time>${fmtDate(n.created_at)}</time>
          </div>`;
        }).join('')
      : `<div class="notif">${t('no_notifications')}</div>`;
    // Following a notification closes the bell menu.
    menu.querySelectorAll('.notif-link').forEach((a) => a.addEventListener('click', () => { menu.hidden = true; }));
    const markBtn = document.getElementById('mark-read');
    if (markBtn) markBtn.onclick = async () => { await api('/notifications/read', { method: 'POST', body: {} }); pollNotifications(); };
  } catch { /* not fatal */ }
  notifTimer = setTimeout(pollNotifications, 30000);
}

document.getElementById('bell').addEventListener('click', async () => {
  const menu = document.getElementById('bell-menu');
  const bell = document.getElementById('bell');
  const opening = menu.hidden;
  menu.hidden = !menu.hidden;
  bell.setAttribute('aria-expanded', String(!menu.hidden));
  // Opening the bell counts as "seen": clear the unread badge now and mark them
  // read on the server, so it stays clear until a new notification arrives.
  if (opening) {
    const count = document.getElementById('bell-count');
    if (count && !count.hidden) {
      count.hidden = true;
      try { await api('/notifications/read', { method: 'POST', body: {} }); } catch { /* not fatal */ }
      pollNotifications();
    }
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.bell-wrap')) document.getElementById('bell-menu').hidden = true;
});

document.getElementById('lang-toggle').addEventListener('click', () => {
  setLang(LANG === 'en' ? 'he' : 'en');
  renderChrome();
  route();
});

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}
document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
});
// Sync the toggle icon with the theme set by the no-flash head script.
applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

// ---------- router ----------

const main = document.getElementById('main');

function closeSse() {
  if (state.sse) { state.sse.close(); state.sse = null; }
}

// The Live-results tab polls for newly-started races; stop it on navigation.
let livePollTimer = null;
function stopLivePoll() {
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
}

// Highlight the top-nav link for the current page (Home / Finished races /
// League / Start lists / Admin), like the standings tabs.
function setActiveNav(page) {
  const key = { '': 'home', live: 'live', finished: 'finished', leagues: 'leagues', league: 'leagues', myleagues: 'leagues', contact: 'contact', startlists: 'startlists', admin: 'admin' }[page || ''];
  const linkKey = { '#/': 'home', '#/live': 'live', '#/finished': 'finished', '#/leagues': 'leagues', '#/contact': 'contact', '#/startlists': 'startlists', '#/admin': 'admin' };
  document.querySelectorAll('.topnav a').forEach((a) => {
    const on = key && linkKey[a.getAttribute('href')] === key;
    a.classList.toggle('active', !!on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

async function route() {
  closeSse();
  stopLivePoll();
  const hash = location.hash.slice(1) || '/';
  const [, page, arg, sub] = hash.match(/^\/([^/]*)\/?([^/]*)\/?([^/]*)/) || [];
  setActiveNav(page);
  try {
    if (!page) return viewHome();
    if (page === 'login') return viewLogin();
    if (page === 'live') return viewLiveRaces();
    if (page === 'finished') return viewFinishedRaces();
    if (page === 'startlists') return viewStartLists();
    if (page === 'results') return viewPublicResults(Number(arg), sub || 'winners');
    if (page === 'leagues') return viewLeagues();
    if (page === 'myleagues') return viewMyLeagues();
    if (page === 'contact') return viewContact();
    if (page === 'league') return viewLeague(Number(arg), sub || 'teams');
    if (page === 'contest') return viewContest(Number(arg), sub || '');
    if (page === 'profile') return viewProfile(Number(arg));
    if (page === 'admin') return viewAdmin(arg || 'leagues');
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
      <div class="brand-row">
        <img class="hero-logo" src="${BASE}/velogrip-logo.png" alt="VeloGrip" width="739" height="553">
        <h1>${t('hero_title')}</h1>
      </div>
      <p>${t('hero_sub')}</p>
    </div>
    <form class="searchbar" id="search-form" role="search">
      <input type="search" id="q" placeholder="${t('search_placeholder')}" aria-label="${t('search_placeholder')}">
      <button class="btn" type="submit">🔍</button>
    </form>
    <div id="finished-home"></div>`;

  document.getElementById('search-form').onsubmit = (e) => { e.preventDefault(); loadRecentFinished(); };
  loadRecentFinished();
}

// The most recently finished races (last 3, or all matches when searching),
// each linking straight to its public results.
async function loadRecentFinished() {
  const box = document.getElementById('finished-home');
  if (!box) return;
  const q = (document.getElementById('q')?.value || '').trim();
  try {
    const params = new URLSearchParams({ status: 'finished' });
    if (q) params.set('q', q);
    const { contests } = await api(`/contests?${params}`);
    const sorted = contests.slice().sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
    const list = q ? sorted : sorted.slice(0, 3);
    box.innerHTML = list.length
      ? `<h2 class="page-title-center">${t('recently_finished')}</h2>
         <div class="grid">${list.map((c) => `
           <a class="card contest-card" href="#/results/${c.id}" style="color:inherit;text-decoration:none">
             <div><span class="pill">🏁 ${esc(sportLabel(c.sport))}</span>
               <span class="pill finished">${t('status_finished')}</span></div>
             <h3>${esc(c.title)}</h3>
             <div class="meta">
               ${c.location ? `<span>📍 ${esc(c.location)}</span>` : ''}
               <span>🗓 ${fmtDate(c.start_at)}</span>
             </div>
           </a>`).join('')}</div>`
      : `<p class="muted">${t('no_finished_races')}</p>`;
  } catch { /* not fatal */ }
}

// ---------- finished races (public results directory) ----------

async function viewFinishedRaces() {
  main.innerHTML = `
    <div class="brand-row">
      <img class="hero-logo" src="${BASE}/velogrip-logo.png" alt="VeloGrip" width="739" height="553">
      <h1 class="page-title-center">${t('nav_finished')}</h1>
    </div>
    <div id="finished-list"></div>`;
  const { contests } = await api('/contests?status=finished');
  const races = (contests || []).filter((c) => c.kind === 'race');
  const box = document.getElementById('finished-list');
  if (!races.length) { box.innerHTML = `<p class="muted">${t('no_finished_races')}</p>`; return; }

  // Group by league: a section per league (sorted by name), then a
  // "Not in a league" section, each header naming the league.
  const byLeague = new Map();
  const noLeague = [];
  for (const c of races) {
    const league = String(c.league_names || '').trim();
    if (!league) { noLeague.push(c); continue; }
    if (!byLeague.has(league)) byLeague.set(league, []);
    byLeague.get(league).push(c);
  }
  const section = (label, cards) => `<h2 class="league-section">${esc(label)}</h2>
    <div class="grid">${cards.map(finishedCard).join('')}</div>`;
  box.innerHTML =
    [...byLeague.keys()].sort().map((name) => section(name, byLeague.get(name))).join('')
    + (noLeague.length ? section(t('league_group_free'), noLeague) : '');

  // The 🏆 league pill sits inside the card's link, so intercept its click and
  // route to the league page instead of the race results.
  const openLeague = (el) => { location.hash = `#/league/${el.dataset.league}`; };
  box.querySelectorAll('.league-link').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openLeague(el); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openLeague(el); }
    });
  });
}

function finishedCard(c) {
  const league = String(c.league_names || '').trim();
  return `
    <a class="card contest-card" href="#/results/${c.id}" style="color:inherit;text-decoration:none">
      <div class="card-head">
        <div class="card-pills">
          ${league ? (c.league_id
            ? `<span class="pill tag league-link" data-league="${c.league_id}" role="link" tabindex="0"
                 title="${t('open_league')}" style="cursor:pointer;text-decoration:underline">🏆 ${esc(league)}</span>`
            : `<span class="pill tag">🏆 ${esc(league)}</span>`) : ''}
          <span class="pill">🏁 ${esc(sportLabel(c.sport))}</span>
          <span class="pill finished">${t('status_finished')}</span>
        </div>
        <span class="pill view-results">${t('view_results_link')} ❯</span>
      </div>
      <h3>${esc(c.title)}</h3>
      <div class="meta">
        ${c.location ? `<span>📍 ${esc(c.location)}</span>` : ''}
        <span>🗓 ${fmtDate(c.start_at)}</span>
      </div>
    </a>`;
}

// ---------- live results (active races, auto-refreshing) ----------

async function viewLiveRaces() {
  main.innerHTML = `
    <div class="brand-row">
      <img class="hero-logo" src="${BASE}/velogrip-logo.png" alt="VeloGrip" width="739" height="553">
      <h1 class="page-title-center">${t('nav_live')}</h1>
    </div>
    <p class="muted" style="text-align:center;margin:-10px 0 18px">${t('live_updates_note')}</p>
    <div id="live-list"></div>`;
  await loadLiveRaces();
  // Poll so a race that goes live (or finishes) shows up without a reload.
  livePollTimer = setInterval(loadLiveRaces, 15000);
}

async function loadLiveRaces() {
  const box = document.getElementById('live-list');
  if (!box) { stopLivePoll(); return; }
  try {
    // The server decides what "live" means (started + recently active, not
    // finished) — see GET /contests/live.
    const { contests } = await api('/contests/live');
    const races = contests || [];
    setLiveDot(races.length > 0);
    box.innerHTML = races.length
      ? `<div class="grid">${races
          .slice()
          .sort((a, b) => new Date(b.start_at) - new Date(a.start_at))
          .map(liveCard)
          .join('')}</div>`
      : `<p class="muted" style="text-align:center">${t('no_live_races')}</p>`;
  } catch { /* transient: keep the last render */ }
}

function liveCard(c) {
  const league = String(c.league_names || '').trim();
  return `
    <a class="card contest-card" href="#/results/${c.id}" style="color:inherit;text-decoration:none">
      <div class="card-head">
        <div class="card-pills">
          ${league ? `<span class="pill tag">🏆 ${esc(league)}</span>` : ''}
          <span class="pill">🏁 ${esc(sportLabel(c.sport))}</span>
          <span class="pill live"><span class="live-dot"></span>${t('hero_live')}</span>
        </div>
        <span class="pill view-results">${t('view_results_link')} ❯</span>
      </div>
      <h3>${esc(c.title)}</h3>
      <div class="meta">
        ${c.location ? `<span>📍 ${esc(c.location)}</span>` : ''}
        <span>🗓 ${fmtDate(c.start_at)}</span>
      </div>
    </a>`;
}

// Light the ● on the nav tab whenever a race is live, from any page.
function setLiveDot(on) {
  const dot = document.querySelector('#nav-live .live-dot');
  if (dot) dot.hidden = !on;
}
async function refreshLiveDot() {
  try {
    const { contests } = await api('/contests/live');
    setLiveDot((contests || []).length > 0);
  } catch { /* ignore */ }
}

// ---------- contact / about ----------

function viewContact() {
  const email = 'velogrip2025@gmail.com';
  const waLink = '972508291600';
  main.innerHTML = `
    <div class="brand-row">
      <img class="hero-logo" src="${BASE}/velogrip-logo.png" alt="VeloGrip" width="739" height="553">
      <h1 class="page-title-center">${t('nav_contact')}</h1>
    </div>
    <div class="card" style="max-width:640px;margin:0 auto">
      <p style="margin:0 0 16px;line-height:1.7">${t('contact_about')}</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center">
        <a class="btn secondary" href="mailto:${email}">✉️ ${t('contact_email_btn')}</a>
        <a class="btn secondary" href="https://wa.me/${waLink}" target="_blank" rel="noopener">💬 ${t('contact_whatsapp_btn')}</a>
      </div>
    </div>`;
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
        <div class="pw-wrap">
          <input id="f-password" type="password" required minlength="8" autocomplete="current-password">
          <button type="button" class="pw-toggle" data-target="f-password" tabindex="-1" aria-label="${t('show_password')}" aria-pressed="false">${eyeSvg(false)}</button>
        </div>
        <button class="btn mt" type="submit" id="auth-submit">${t('login')}</button>
        <p id="auth-msg" class="auth-msg" role="status" hidden></p>
      </form>
    </div>`;
  const authMsg = document.getElementById('auth-msg');
  const showAuthMsg = (text, kind) => {
    authMsg.textContent = text;
    authMsg.className = `auth-msg ${kind}`;
    authMsg.hidden = !text;
  };
  let mode = 'login';
  const setMode = (m) => {
    mode = m;
    document.getElementById('name-field').hidden = m === 'login';
    document.getElementById('auth-submit').textContent = t(m);
    document.getElementById('tab-login').setAttribute('aria-selected', String(m === 'login'));
    document.getElementById('tab-register').setAttribute('aria-selected', String(m === 'register'));
    showAuthMsg('', ''); // clear any message when switching tabs
  };
  document.getElementById('tab-login').onclick = () => setMode('login');
  document.getElementById('tab-register').onclick = () => setMode('register');
  wirePasswordToggles(main);
  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    showAuthMsg('', '');
    const wasRegister = mode === 'register';
    try {
      const body = {
        email: document.getElementById('f-email').value,
        password: document.getElementById('f-password').value,
      };
      if (mode === 'register') body.name = document.getElementById('f-name').value;
      const data = await api(`/auth/${mode}`, { method: 'POST', body });
      if (data.pending) {
        // New registration awaiting admin approval — no session yet.
        setMode('login');
        showAuthMsg(t('registration_pending'), 'notice');
        return;
      }
      setSession(data.token, data.user);
      location.hash = '#/';
    } catch (err) {
      // Show every auth message inline under the button, not as a bottom toast.
      const pending = /pending approval/i.test(err.message || '');
      showAuthMsg(pending ? t('account_pending') : err.message, pending && !wasRegister ? 'notice' : 'error');
    }
  };
}

// Eye / eye-off icon (stroke uses currentColor so it stays visible in both
// themes). `shown` = the password is currently visible → show the crossed-out eye.
function eyeSvg(shown) {
  const common = 'viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return shown
    ? `<svg ${common}><path d="M17.94 17.94A10.5 10.5 0 0 1 12 19c-6.5 0-10-7-10-7a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.6 9.6 0 0 1 12 4c6.5 0 10 7 10 7a18.3 18.3 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`
    : `<svg ${common}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

// Show/hide toggle for any password field wrapped in .pw-wrap (the eye button
// carries data-target="<input id>"). tabindex=-1 keeps it out of the tab order
// so it never interferes with typing in the field.
function wirePasswordToggles(root) {
  (root || document).querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.onclick = () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = eyeSvg(show);
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', t(show ? 'hide_password' : 'show_password'));
      btn.classList.toggle('on', show);
    };
  });
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
  overlay.innerHTML = `<div style="background:var(--surface);border-radius:10px;max-width:560px;width:100%;overflow:hidden">
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
          <th>${t('status')}</th><th>${t('location')}</th><th>${t('sport')}</th><th>${t('nav_leagues')}</th><th></th>
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

async function loadStartLists(highlightId) {
  const { races } = await api('/my/races');
  document.getElementById('races-found').textContent = t('races_found', { n: races.length });
  // Admins can (re)assign a start list to a league right here.
  const isAdmin = state.user && state.user.role === 'admin';
  let leagues = [];
  if (isAdmin) { try { leagues = (await api('/leagues?status=all')).leagues || []; } catch { /* no leagues */ } }
  const body = document.getElementById('lists-body');

  const leagueCell = (r) => {
    if (!isAdmin || !leagues.length) {
      return r.league_names ? `<span class="pill tag">🏆 ${esc(r.league_names)}</span>` : '';
    }
    return `<select class="assign-league" data-id="${r.id}" data-current="${r.league_id || ''}" style="max-width:180px">
      <option value="">— ${t('league_group_free')}</option>
      ${leagues.map((l) => `<option value="${l.id}" ${r.league_id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
    </select>`;
  };

  const statusCell = (r) => `
    <select class="assign-status" data-id="${r.id}" data-current="${r.status}" style="max-width:130px">
      <option value="active" ${r.status === 'finished' ? '' : 'selected'}>${t('status_active')}</option>
      <option value="finished" ${r.status === 'finished' ? 'selected' : ''}>${t('status_finished')}</option>
    </select>`;

  const rowHtml = (r) => `
    <tr data-row-id="${r.id}">
      <td><a href="#/contest/${r.id}/startlist" style="color:var(--ok);font-weight:600">${esc(r.title)}</a></td>
      <td>${r.racer_count}</td>
      <td>${new Date(r.start_at).toLocaleDateString(LANG === 'he' ? 'he-IL' : 'en-US',
        { year: 'numeric', month: 'short', day: 'numeric' })}</td>
      <td>${statusCell(r)}</td>
      <td>${esc(r.location || '')}</td>
      <td>${r.sport ? esc(sportLabel(r.sport)) : ''}</td>
      <td>${leagueCell(r)}</td>
      <td style="white-space:nowrap">
        <button class="ghost list-dup" data-id="${r.id}" data-title="${esc(r.title)}" title="${t('duplicate_race')}" aria-label="${t('duplicate_race')}">⧉</button>
        <button class="ghost list-del" data-id="${r.id}" data-title="${esc(r.title)}" aria-label="${t('delete')}">✕</button>
      </td>
    </tr>`;
  const sep = (label) => `<tr class="dist-sep"><td colspan="8">🏆 ${esc(label)}</td></tr>`;

  if (!races.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted">${t('no_contests')}</td></tr>`;
  } else if (!races.some((r) => String(r.league_names || '').trim())) {
    body.innerHTML = races.map(rowHtml).join(''); // none in a league -> flat list
  } else {
    // Group under a header per league, then a "Not in a league" section.
    const byLeague = new Map(); const noLeague = [];
    for (const r of races) {
      const lg = String(r.league_names || '').trim();
      if (!lg) noLeague.push(r);
      else { if (!byLeague.has(lg)) byLeague.set(lg, []); byLeague.get(lg).push(r); }
    }
    body.innerHTML =
      [...byLeague.keys()].sort().map((name) => sep(name) + byLeague.get(name).map(rowHtml).join('')).join('')
      + (noLeague.length ? sep(t('league_group_free')) + noLeague.map(rowHtml).join('') : '');
  }
  body.querySelectorAll('.assign-league').forEach((sel) => {
    sel.onchange = async () => {
      const raceId = sel.dataset.id;
      const current = sel.dataset.current; // league id it's in now ('' if none)
      const next = sel.value;
      try {
        if (current && current !== next) await api(`/leagues/${current}/races/${raceId}`, { method: 'DELETE' });
        if (next && next !== current) await api(`/leagues/${next}/races`, { method: 'POST', body: { contest_id: Number(raceId) } });
        toast(t('league_saved'));
        loadStartLists();
      } catch (err) { toast(err.message, true); loadStartLists(); }
    };
  });
  body.querySelectorAll('.assign-status').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api(`/contests/${sel.dataset.id}/status`, { method: 'PATCH', body: { status: sel.value } });
        toast(t('status_saved'));
        loadStartLists();
      } catch (err) { toast(err.message, true); loadStartLists(); }
    };
  });
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
  body.querySelectorAll('.list-dup').forEach((btn) => {
    btn.onclick = async () => {
      const title = prompt(t('duplicate_race_prompt'), `${btn.dataset.title} ${new Date().getFullYear()}`);
      if (title === null) return;
      try {
        const dup = await api(`/contests/${btn.dataset.id}/duplicate`, { method: 'POST', body: { title: title.trim() } });
        toast(t('duplicated_ok'));
        await loadStartLists(dup.id); // stay here; point at the new list and blink it
      } catch (err) { toast(err.message, true); }
    };
  });

  // Highlight a just-created list: scroll it into view and blink it twice.
  if (highlightId != null) {
    const row = body.querySelector(`tr[data-row-id="${highlightId}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('row-blink');
      row.addEventListener('animationend', () => row.classList.remove('row-blink'), { once: true });
    }
  }
}

// ---------- contest page ----------

let renderGeneration = 0;

async function viewContest(id, tab) {
  const generation = ++renderGeneration;
  const c = await api(`/contests/${id}`);
  if (generation !== renderGeneration) return; // a newer render superseded this one
  const tabs = ['details', 'startlist'];
  if (c.is_organizer) tabs.push('manage');
  tabs.push('results');
  if (!tabs.includes(tab)) tab = 'details';
  main.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:start;flex-wrap:wrap">
      <div>
        <h1 id="race-title" style="margin:0 0 4px;display:inline-flex;align-items:center;gap:8px">
          <span>${esc(c.title)}</span>
          ${c.is_organizer ? `<button id="title-edit" class="ghost" title="${t('edit')}" aria-label="${t('edit')}" style="font-size:0.6em;padding:2px 6px">✏️</button>` : ''}
        </h1>
        <div class="muted">
          <span class="pill">🏁 ${esc(sportLabel(c.sport))}</span>
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

  // Inline rename: the ✏️ swaps the heading for an input (organizers only).
  const titleEdit = document.getElementById('title-edit');
  if (titleEdit) titleEdit.onclick = () => {
    const h1 = document.getElementById('race-title');
    h1.innerHTML = `<input id="title-input" value="${esc(c.title)}" maxlength="120"
        style="font-size:0.85rem;min-width:220px;font-weight:700">
      <button id="title-save" class="btn small secondary">${t('save')}</button>
      <button id="title-cancel" class="ghost" aria-label="${t('cancel')}">✕</button>`;
    const input = document.getElementById('title-input');
    input.focus(); input.select();
    const save = async () => {
      const title = input.value.trim();
      if (!title) { input.focus(); return; }
      try {
        await api(`/contests/${id}`, { method: 'PATCH', body: { title } });
        toast(t('saved'));
        viewContest(id, tab); // re-render with the new heading everywhere
      } catch (err) { toast(err.message, true); }
    };
    document.getElementById('title-save').onclick = save;
    document.getElementById('title-cancel').onclick = () => viewContest(id, tab);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') viewContest(id, tab);
    };
  };

  const box = document.getElementById('tab-content');
  if (tab === 'results') renderRaceResults(box, c);
  else if (tab === 'startlist') renderStartlist(box, c);
  else if (tab === 'details') renderDetails(box, c);
  else if (tab === 'manage') renderManage(box, c);
}

async function renderDetails(box, c) {
  const generation = renderGeneration;
  // The race-info panel needs the roster (racer count + start type), which the
  // results feed provides; fall back to an empty list if it isn't ready.
  const data = await api(`/contests/${c.id}/race-results`).catch(() => ({ results: [] }));
  if (generation !== renderGeneration) return;
  box.innerHTML = `
    ${raceInfoPanel(c, data.results)}
    <div class="card">
      <ul class="stat-list">
        <li><span>${t('starts')}</span><strong>${fmtDate(c.start_at)}</strong></li>
        <li><span>${t('ends')}</span><strong>${fmtDate(c.end_at)}</strong></li>
        <li><span>${t('status')}</span><strong>${c.status === 'finished' ? t('status_finished') : t('hero_live')}</strong></li>
        ${c.invite_code ? `<li><span>${t('invite_code')}</span><strong><code>${esc(c.invite_code)}</code></strong></li>` : ''}
      </ul>
      ${c.description ? `<p style="white-space:pre-wrap;margin-top:8px">${esc(c.description)}</p>` : ''}
      ${(c.tags || []).length ? `<div style="margin-top:6px">${(c.tags || []).map((tag) => `<span class="pill tag">#${esc(tag)}</span>`).join(' ')}</div>` : ''}
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
  const canEdit = isAdmin(); // editing results is restricted to admins

  box.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${t('race_results')} ${c.status === 'finished'
          ? `<span class="pill finished">${t('final_results_label')}</span>`
          : `<span class="live-indicator">● ${t('live')}</span>`}</h3>
        <div style="display:flex;gap:8px;align-items:center">
          ${categories.length ? `<select id="cat-filter" aria-label="${t('category')}">
            <option value="">${t('all_cats')}</option>
            ${categories.map((cat) => `<option value="${esc(cat)}">${esc(cat)}</option>`).join('')}
          </select>` : ''}
          ${c.is_organizer ? `<button class="btn small secondary" id="rr-dl-csv">⬇ ${t('export_csv')}</button>
          <button class="btn small secondary" id="rr-dl-taps">⬇ ${t('export_taps')}</button>
          ${c.league_id ? `<button class="btn small secondary" id="rr-dl-individual">⬇ ${t('individual_pdf')}</button>
          <button class="btn small secondary" id="rr-dl-team">⬇ ${t('team_pdf')}</button>` : ''}` : ''}
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="board"><thead><tr>
          <th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('category')}</th>
          <th>${t('category_place')}</th><th>${t('distance')}</th><th>${t('wave')}</th><th>${t('laps')}</th><th>${t('elapsed_col')}</th><th>${t('behind')}</th>${canEdit ? '<th></th>' : ''}
        </tr></thead><tbody id="race-results-body"></tbody></table>
      </div>
    </div>`;

  const csvBtn = box.querySelector('#rr-dl-csv');
  if (csvBtn) csvBtn.onclick = () => downloadAuthed(`/contests/${c.id}/race-results?format=csv`, `race-results-${c.id}.csv`);
  const tapsBtn = box.querySelector('#rr-dl-taps');
  if (tapsBtn) tapsBtn.onclick = () => downloadAuthed(`/contests/${c.id}/taps`, `taps-${c.id}.csv`);
  const indBtn = box.querySelector('#rr-dl-individual');
  if (indBtn) indBtn.onclick = () => downloadAuthed(`/contests/${c.id}/race-results?format=pdf&doc=individual`, `individual-${c.id}.pdf`);
  const teamBtn = box.querySelector('#rr-dl-team');
  if (teamBtn) teamBtn.onclick = () => downloadAuthed(`/contests/${c.id}/race-results?format=pdf&doc=team`, `team-${c.id}.pdf`);

  const editKey = (r) => r.bib || ('epc:' + r.epc);
  const editCell = (r) => (canEdit
    ? `<td><button class="btn small secondary rr-edit" data-key="${esc(editKey(r))}">✎ ${t('edit_result')}</button></td>` : '');
  let currentResults = data.results;

  const draw = (results) => {
    currentResults = results;
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
          ${editCell(r)}
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
          ${editCell(r)}
        </tr>`),
    ].join('') || `<tr><td colspan="${canEdit ? 11 : 10}" class="muted">${t('no_results_yet')}</td></tr>`;
  };
  draw(data.results);

  const filter = box.querySelector('#cat-filter');
  const refetch = async () => {
    const fresh = await api(`/contests/${c.id}/race-results`);
    draw(fresh.results);
    return fresh.results;
  };
  if (filter) filter.onchange = refetch;

  // Admin: open the per-racer result editor (status + crossings) on ✎ click.
  if (canEdit) {
    box.querySelector('#race-results-body').addEventListener('click', (e) => {
      const btn = e.target.closest('.rr-edit');
      if (!btn) return;
      const row = currentResults.find((r) => editKey(r) === btn.dataset.key);
      if (row) openResultEditor(c, row, refetch);
    });
  }

  closeSse();
  state.sse = new EventSource(`${BASE}/api/contests/${c.id}/stream`);
  state.sse.addEventListener('tag_reads', refetch);
  state.sse.addEventListener('wave_start', refetch);
}

// Elapsed helpers for the result editor: ms <-> "h:mm:ss" / "m:ss".
function msToClock(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.floor(ms / 1000), pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function parseClock(str) {
  const parts = String(str || '').trim().split(':').map((x) => x.trim());
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  const s = n.length === 1 ? n[0] : n.length === 2 ? n[0] * 60 + n[1]
    : n.length === 3 ? n[0] * 3600 + n[1] * 60 + n[2] : null;
  return s == null ? null : s * 1000;
}

// Organizer result editor: results are recomputed from raw crossings + a status
// override, so editing here means (a) setting DNS/DNF/DSQ/auto and (b) adding or
// deleting the racer's crossings (each crossing = a finish or lap). `refetch`
// redraws the results table; after each change we reopen with fresh data.
async function openResultEditor(c, row, refetch) {
  const key = row.bib || ('epc:' + row.epc);
  const { reads } = await api(`/contests/${c.id}/reads?limit=2000`);
  const epcs = row.epcs || [row.epc];
  const mine = reads
    .filter((x) => (row.bib && x.bib === row.bib) || epcs.includes(x.epc))
    .sort((a, b) => Date.parse(a.read_at) - Date.parse(b.read_at));
  const waveStart = row.wave_started_at ? Date.parse(row.wave_started_at) : null;
  const canAdd = waveStart && row.bib; // a timed manual crossing needs a wave start + bib

  const statusSel = `<select id="re-status" aria-label="${t('result_status')}" style="width:auto">
    ${['', 'DNS', 'DNF', 'DSQ'].map((s) => `<option value="${s}" ${row.racer_status === s ? 'selected' : ''}>${s || t('status_ok')}</option>`).join('')}
  </select>`;
  const crossRows = mine.length
    ? mine.map((x, i) => {
        const el = waveStart ? msToClock(Date.parse(x.read_at) - waveStart) : '';
        const timeCell = waveStart
          ? `<input class="re-lap" data-readid="${x.id}" value="${esc(el)}" aria-label="${t('result_elapsed_col')} ${i + 1}" style="width:100px;font-variant-numeric:tabular-nums">`
          : `<strong>—</strong>`;
        const saveBtn = waveStart
          ? `<button class="btn small re-lapsave" data-readid="${x.id}" title="${t('result_save_crossing')}">✓</button> ` : '';
        return `<tr>
          <td>${timeCell}</td>
          <td class="muted" style="font-size:.85em">${esc(x.reader_name || '')}${x.reader_location === 'manual' ? ` · ${t('result_manual')}` : ''}</td>
          <td style="white-space:nowrap">${saveBtn}<button class="btn small danger re-del" data-readid="${x.id}" title="${t('result_del_crossing')}">🗑</button></td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="3" class="muted">${t('result_no_crossings')}</td></tr>`;
  const addRow = canAdd
    ? `<div style="display:flex;gap:6px;align-items:center;margin-top:12px;flex-wrap:wrap">
         <label for="re-elapsed">${t('result_add_crossing')}</label>
         <input id="re-elapsed" placeholder="${t('result_elapsed_ph')}" style="width:110px">
         <button class="btn small" id="re-add">${t('result_add_btn')}</button>
       </div>`
    : `<p class="muted" style="margin-top:12px">${t('result_need_wave')}</p>`;

  const body = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <strong>${t('result_status')}:</strong> ${statusSel}
    </div>
    <h4 style="margin:0 0 6px">${t('result_crossings')} <span class="muted" style="font-weight:400">(${t('result_elapsed_col')})</span></h4>
    <div style="overflow-x:auto"><table class="board"><tbody>${crossRows}</tbody></table></div>
    ${addRow}`;
  const root = openModal(`✎ ${esc(row.participant || row.bib || '')}`, body);

  const reopen = async () => {
    const results = await refetch();
    const updated = results.find((r) => (r.bib || ('epc:' + r.epc)) === key);
    if (updated) openResultEditor(c, updated, refetch); else closeModal();
  };

  root.querySelector('#re-status').onchange = async (e) => {
    try {
      await api(`/contests/${c.id}/racer-status`, { method: 'PATCH', body: { bib: row.bib || '', epc: row.epc, status: e.target.value } });
      toast(t('result_saved')); await reopen();
    } catch (err) { toast(String(err.message || err), true); }
  };
  root.querySelectorAll('.re-del').forEach((b) => (b.onclick = async () => {
    try {
      await api(`/contests/${c.id}/reads/${b.dataset.readid}`, { method: 'DELETE' });
      toast(t('result_saved')); await reopen();
    } catch (err) { toast(String(err.message || err), true); }
  }));
  const saveLap = async (readId, input) => {
    const ms = parseClock(input.value);
    if (ms == null) return toast(t('result_bad_elapsed'), true);
    try {
      await api(`/contests/${c.id}/reads/${readId}`, { method: 'PATCH', body: { at: new Date(waveStart + ms).toISOString() } });
      toast(t('result_saved')); await reopen();
    } catch (err) { toast(String(err.message || err), true); }
  };
  root.querySelectorAll('.re-lapsave').forEach((b) => (b.onclick = () =>
    saveLap(b.dataset.readid, root.querySelector(`.re-lap[data-readid="${b.dataset.readid}"]`))));
  root.querySelectorAll('.re-lap').forEach((inp) => (inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveLap(inp.dataset.readid, inp); }
  }));
  const addBtn = root.querySelector('#re-add');
  if (addBtn) addBtn.onclick = async () => {
    const ms = parseClock(root.querySelector('#re-elapsed').value);
    if (ms == null) return toast(t('result_bad_elapsed'), true);
    try {
      await api(`/contests/${c.id}/manual-read`, { method: 'POST', body: { bib: row.bib, at: new Date(waveStart + ms).toISOString() } });
      toast(t('result_saved')); await reopen();
    } catch (err) { toast(String(err.message || err), true); }
  };
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
      <p style="text-align:center;margin:0 0 12px;color:var(--muted)">${esc(fmtDate(c.start_at))} — ${c.status === 'finished' ? t('final_results_label') : t('results_word')}</p>
      ${raceInfoPanel(c, data.results)}
      <div class="pubtabs">
        ${tabs.map(([k, key]) => `<a class="pubtab ${tab === k ? 'active' : ''}" href="#/results/${id}/${k}">${t(key)}</a>`).join('')}
      </div>
      ${state.user ? `<div style="text-align:center;margin:8px 0">
        <button class="btn small secondary" id="dl-csv">⬇ ${t('export_csv')}</button>
        <button class="btn small secondary" id="dl-taps">⬇ ${t('export_taps')}</button>
      </div>` : ''}
      <div id="pubbody"></div>
    </div>`;

  const csvBtn = document.getElementById('dl-csv');
  if (csvBtn) csvBtn.onclick = () => downloadAuthed(`/contests/${id}/race-results?format=csv`, `race-results-${id}.csv`);
  const tapsBtn = document.getElementById('dl-taps');
  if (tapsBtn) tapsBtn.onclick = () => downloadAuthed(`/contests/${id}/taps`, `taps-${id}.csv`);

  let currentResults = data.results;
  const render = (results) => {
    currentResults = results;
    const body = document.getElementById('pubbody');
    if (!body) return;
    const qi = location.hash.indexOf('?');
    const qs = qi >= 0 ? new URLSearchParams(location.hash.slice(qi + 1)) : null;
    if (tab === 'live' && qs && qs.has('dist')) {
      body.innerHTML = liveRaceView(results, id, qs.get('dist') || '', qs.get('cat') || '', qs.get('gender') || '', c.status === 'finished');
    } else if (qs && qs.has('dist')) {
      body.innerHTML = filteredResultsTable(results, id, qs.get('dist') || '', qs.get('cat') || '', qs.get('gender') || '');
    } else if (tab === 'full') body.innerHTML = fullResultsTable(results, isAdmin());
    else if (tab === 'laps') body.innerHTML = lapTimesTables(results);
    else if (tab === 'top3') body.innerHTML = topFinishersTables(results, 3);
    else body.innerHTML = raceWinnersTables(id, results, c.status === 'finished');
  };
  render(data.results);

  state.sse = new EventSource(`${BASE}/api/contests/${id}/stream`);
  const refetch = async () => {
    const fresh = await api(`/contests/${id}/race-results`);
    render(fresh.results);
    return fresh.results;
  };
  state.sse.addEventListener('tag_reads', refetch);
  state.sse.addEventListener('wave_start', refetch);

  // Admin: the Full results tab exposes ✎ Edit per racer (same editor as the
  // Results tab). The #pubbody element persists across renders, so delegate once.
  if (isAdmin()) {
    document.getElementById('pubbody').addEventListener('click', (e) => {
      const btn = e.target.closest('.rr-edit');
      if (!btn) return;
      const row = currentResults.find((r) => (r.bib || ('epc:' + r.epc)) === btn.dataset.key);
      if (row) openResultEditor(c, row, refetch);
    });
  }
}

// "Race info" box shown above the results tabs (mirrors the reference layout).
function raceInfoPanel(c, results) {
  const waves = [...new Set(results.map((r) => r.wave).filter(Boolean))];
  const startType = waves.length > 1 ? t('waves_start') : t('mass_start');
  const loc = c.location
    ? `${esc(c.location)} &nbsp;<a href="https://www.google.com/maps/search/${encodeURIComponent(c.location)}" target="_blank" rel="noopener" style="color:var(--primary);font-weight:600">${t('view_on_map')}</a>`
    : '–';
  const rows = [
    [t('sport'), esc(sportLabel(c.sport))],
    [t('location'), loc],
    [t('start_type'), startType],
    [t('racers'), results.length],
    [t('timed_on'), t('timed_on_value')],
    [t('timed_with'), 'VeloGripScorer'],
    [t('chip_timing'), 'RFID - LLRP'],
    ...(c.reader_names && c.reader_names.length ? [[t('rfid_reader'), esc(c.reader_names.join(', '))]] : []),
    [t('updated_from'), t('app_label')],
    [t('race_visibility'), c.visibility === 'public' ? t('visibility_public') : t('visibility_private')],
  ];
  // Responsive columns (flex-basis with shrink) so the panel never forces the
  // page wider than the viewport; they wrap to one column on narrow screens.
  const photo = c.photo_url
    ? `<div style="flex:1 1 240px;max-width:320px;min-height:180px;border-radius:var(--r-md);background:#000 center/cover no-repeat url('${c.photo_url}')"></div>` : '';
  // align-items:stretch makes both columns share the taller height, and the info
  // box grows to fit its text (no inner scrollbar).
  return `<div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:center;align-items:stretch;margin-bottom:16px">
    ${photo}
    <div class="card" style="flex:1 1 260px;max-width:340px;margin:0;padding:12px;box-sizing:border-box;display:flex;flex-direction:column">
      <div style="background:var(--menu-section-bg,#eee);font-weight:700;padding:5px 10px;margin:-12px -12px 8px;border-radius:8px 8px 0 0;font-size:13px">${t('race_info')}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <tbody>${rows.map(([k, v]) => `<tr>
          <td style="text-align:right;color:var(--muted);padding:2px 8px 2px 0;white-space:nowrap;vertical-align:top">${k}:</td>
          <td style="font-weight:600">${v}</td></tr>`).join('')}</tbody>
      </table>
      <div style="border-top:1px solid var(--border);margin-top:auto;padding-top:6px;color:var(--muted);font-size:12.5px">
        ${t('organized_by')}: <strong style="color:var(--text)">${esc(c.organizer_name || (c.organizer && c.organizer.name) || '')}</strong>
      </div>
    </div>
  </div>`;
}

// League summary card (sport, location, series type, race counts, racers,
// last-updated, organizer) — the league-page equivalent of raceInfoPanel.
function leagueInfoPanel(league, meta) {
  const loc = meta.location
    ? `${esc(meta.location)} &nbsp;<a href="https://www.google.com/maps/search/${encodeURIComponent(meta.location)}" target="_blank" rel="noopener" style="color:var(--primary);font-weight:600">${t('view_on_map')}</a>`
    : null;
  const seriesType = league.settings && league.settings.individual_best_n
    ? t('series_type_points_n', { n: league.settings.individual_best_n, m: meta.race_count })
    : t('series_type_points');
  const rows = [
    ...(meta.sport ? [[t('sport'), esc(sportLabel(meta.sport))]] : []),
    ...(loc ? [[t('location'), loc]] : []),
    [t('series_type'), seriesType],
    [t('series_races'), meta.race_count],
    [t('completed_races'), meta.finished_race_count],
    [t('racers'), meta.racer_count],
    [t('updated_label'), fmtDate(meta.updated_at)],
    [t('organized_by'), 'VeloGrip'],
  ];
  return `<div style="display:flex;justify-content:center;margin-bottom:16px">
    <div class="card" style="flex:1 1 260px;max-width:340px;margin:0;padding:12px;box-sizing:border-box;display:flex;flex-direction:column">
      <div style="background:var(--menu-section-bg,#eee);font-weight:700;padding:5px 10px;margin:-12px -12px 8px;border-radius:8px 8px 0 0;font-size:13px">${t('league_info')}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <tbody>${rows.map(([k, v], i) => `<tr>
          <td style="text-align:right;color:var(--muted);padding:2px 8px 2px 0;white-space:nowrap;vertical-align:top;${i === rows.length - 1 ? 'border-top:1px solid var(--border);padding-top:6px' : ''}">${k}:</td>
          <td style="font-weight:600;${i === rows.length - 1 ? 'border-top:1px solid var(--border);padding-top:6px' : ''}">${v}</td></tr>`).join('')}</tbody>
      </table>
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
      .filter((r) => r.status === 'finished' && (r.lap_ms ? r.lap_ms.length : 0) > 0)
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
    const maxLaps = rows.reduce((m, r) => Math.max(m, r.lap_ms.length), 0);
    if (maxLaps < 2) continue; // lap-times view is only meaningful for multi-lap races
    // Per-lap DURATION: lap i = crossing i minus crossing i-1 (lap 1 from the gun).
    const lapDur = (r, i) => (i < r.lap_ms.length ? fmtElapsedMs(r.lap_ms[i] - (i > 0 ? r.lap_ms[i - 1] : 0)) : null);
    const lapCols = Array.from({ length: maxLaps }, (_, i) => `<th>${t('lap')} ${i + 1}</th>`).join('');
    html += `<div style="overflow-x:auto"><table class="board mt"><thead>
      <tr><th colspan="${3 + maxLaps + 1}">${esc(d || t('overall'))}</th></tr>
      <tr><th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th>${lapCols}<th>${t('elapsed_col')}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><strong>${r.rank}</strong></td><td><strong>${esc(r.bib || '')}</strong></td><td>${esc(r.participant)}</td>
        ${Array.from({ length: maxLaps }, (_, i) => `<td style="font-variant-numeric:tabular-nums">${lapDur(r, i) || '–'}</td>`).join('')}
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
function liveRaceView(results, id, dist, cat, gender, raceDone) {
  let scope = results.filter((r) => (r.distance || '') === dist);
  if (gender === 'Male') scope = scope.filter((r) => isMaleW(r.gender));
  else if (gender === 'Female') scope = scope.filter((r) => isFemaleW(r.gender));
  if (cat) scope = scope.filter((r) => r.category === cat);
  const finished = scope.filter((r) => r.status === 'finished').sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
  const onCourse = scope.filter((r) => r.status === 'on_course');
  const notStarted = scope.filter((r) => r.status === 'not_started');
  const dns = scope.filter((r) => r.status === 'DNS');
  const dnf = scope.filter((r) => r.status === 'DNF');
  const dsq = scope.filter((r) => r.status === 'DSQ');
  const leader = finished[0] || null;
  const genderCrumb = gender === 'Male' ? t('male') + ' ' : gender === 'Female' ? t('female') + ' ' : '';
  const crumb = `${esc(dist || t('overall'))} ${genderCrumb}- ${cat ? esc(cat) : t('overall')}`;
  const nameCell = (r) => `${esc(r.participant)}${r.team ? `<div class="muted" style="font-size:.78rem">${esc(r.team)}</div>` : ''}`;
  const stat = (n, label, cls) => `<div class="stat-tile ${cls}">
    <div class="stat-num">${n}</div>
    <div class="muted stat-label">${label}</div></div>`;
  const finishedHtml = finished.map((r, i) => {
    const diff = !leader || r.elapsed_ms === leader.elapsed_ms
      ? (i === 0 ? '–' : '') : '+' + fmtElapsedMs(r.elapsed_ms - leader.elapsed_ms);
    return `<tr><td><strong>${r.rank}</strong></td><td>${esc(r.bib || '')}</td><td>${nameCell(r)}</td>
      <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed}</strong></td>
      <td class="muted" style="font-variant-numeric:tabular-nums">${diff}</td></tr>`;
  }).join('') || `<tr><td colspan="5" class="muted">${t('no_results_yet')}</td></tr>`;
  const pillList = (label, rows) => rows.length
    ? `<h3 style="margin:16px 0 6px">${label} <span class="muted">(${rows.length})</span></h3>
       <div style="display:flex;flex-wrap:wrap;gap:6px">${rows
      .slice().sort((a, b) => bibNumW(a.bib) - bibNumW(b.bib))
      .map((r) => `<span class="pill">${esc(r.bib || '')} · ${esc(r.participant)}</span>`).join('')}</div>` : '';
  const onCourseHtml = pillList(t('status_on_course'), onCourse) + pillList('DNS', dns);
  return `
    <p style="margin:12px 0 8px"><a href="#/results/${id}/winners" style="color:var(--brand,#2f8a57);font-weight:700">${t('race_winners')}</a>
      <span class="muted"> » ${crumb} — ${raceDone ? t('results_word') : t('live_race')}</span></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      ${stat(scope.length, t('racers'), 'total')}
      ${stat(finished.length, t('status_finished_r'), 'finished')}
      ${stat(onCourse.length, t('status_on_course'), 'oncourse')}
      ${stat(dnf.length, 'DNF', 'dnf')}
      ${stat(dns.length, 'DNS', 'dns')}
      ${notStarted.length ? stat(notStarted.length, t('status_not_started'), 'notstarted') : ''}
      ${dsq.length ? stat(dsq.length, 'DSQ', 'dns') : ''}
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
      <th>${t('participant')}</th>
      <th>${t('category')}</th><th>${t('gender_col')}</th><th>${t('finish_time')}</th><th>${t('difference')}</th>
    </tr></thead><tbody>${finishedHtml}${othersHtml}</tbody></table></div>`;
}

function raceWinnersTables(id, results, raceDone) {
  const byDist = groupByDistance(results);
  const dists = [...byDist.keys()].sort();
  // One shared table (a distance separator row per distance) so every column
  // aligns across all distances/categories — the leader and time columns size
  // to the longest name across the whole result set, not per distance.
  // Lap times aren't a per-row column here — they live in the top "lap times"
  // tab, so a lap race keeps this table just as clean as a single-lap one.
  const colCount = 5;

  const line = (d, label, scope, indent, catFilter, gender) => {
    const seg = (view) => `#/results/${id}/${view}?dist=${encodeURIComponent(d)}`
      + `&cat=${encodeURIComponent(catFilter || '')}&gender=${encodeURIComponent(gender || '')}`;
    const leader = leaderOf(scope);
    return `<tr>
      <td style="padding-left:${indent}px"><a href="${seg('winners')}" class="cat-link">${arrow()} ${esc(label)}</a></td>
      <td>${leader ? nameWithTeam(leader) : '–'}</td>
      <td style="font-variant-numeric:tabular-nums">${leader ? leader.elapsed : '–'}</td>
      <td style="text-align:center"><strong>${scope.length}</strong></td>
      <td>${raceDone ? `<a href="${seg('live')}" class="live-link">${arrow()} ${t('results_word')}</a>`
        : scope.some((r) => r.wave_started_at) ? `<a href="${seg('live')}" class="live-link">${arrow()} ${t('live_race')}</a>`
        : `<span class="muted">${t('not_started_yet')}</span>`}</td>
    </tr>`;
  };

  const body = dists.map((d) => {
    const rows = byDist.get(d);
    const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
    return `<tr class="dist-sep"><td colspan="${colCount}">${esc(d || t('overall'))}</td></tr>
      ${line(d, t('overall'), rows, 0, '', '')}
      ${rows.some((r) => isFemaleW(r.gender)) ? line(d, t('female'), rows.filter((r) => isFemaleW(r.gender)), 20, '', 'Female') : ''}
      ${rows.some((r) => isMaleW(r.gender)) ? line(d, t('male'), rows.filter((r) => isMaleW(r.gender)), 20, '', 'Male') : ''}
      ${cats.map((cat) => line(d, cat, rows.filter((r) => r.category === cat), 20, cat, '')).join('')}`;
  }).join('');

  return `<p class="muted" style="margin:8px 0">${arrow()} ${t('click_green_category')}</p>
    <div style="overflow-x:auto"><table class="board winners mt">
      <thead><tr>
        <th>${t('category')}</th><th>${t('leader')}</th><th>${t('leading_time')}</th>
        <th style="text-align:center">${t('total_racers')}</th><th>${raceDone ? t('results_word') : t('progress_view')}</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
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
            <td>${nameWithTeam(r)}</td>
            <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed}</strong></td></tr>`).join('')}</tbody>
        </table>`;
    }).join('');
  }).join('') || `<p class="muted">${t('no_results_yet')}</p>`;
}

// Full results split into a section per distance, each ranked on its own
// (a 5k time can't be compared to a 10k, so they're separate competitions).
function fullResultsTable(results, editable) {
  const eKey = (r) => r.bib || ('epc:' + r.epc);
  const eCell = (r) => (editable
    ? `<td><button class="btn small secondary rr-edit" data-key="${esc(eKey(r))}">✎ ${t('edit_result')}</button></td>` : '');
  const byDist = groupByDistance(results);
  const dists = [...byDist.keys()].sort();
  const sections = dists.map((d) => {
    const all = byDist.get(d);
    const finished = all.filter((r) => r.status === 'finished').sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
    const others = all.filter((r) => r.status !== 'finished');
    if (!finished.length && !others.length) return '';
    const lead = finished[0];
    const behindOf = (r, i) => {
      if (i === 0 || !lead) return '';
      if (r.laps < lead.laps) { const g = lead.laps - r.laps; return `-${g} ${g > 1 ? t('laps') : t('lap')}`; }
      return '+' + fmtElapsedMs(r.elapsed_ms - lead.elapsed_ms);
    };
    const finRows = finished.map((r, i) => `<tr class="${i < 3 ? 'top' + (i + 1) : ''}">
      <td><strong>${MEDALS[i + 1] || (i + 1)}</strong></td><td><strong>${esc(r.bib || '')}</strong></td>
      <td>${nameWithTeam(r)}</td>
      <td>${esc(r.category || '')}</td><td>${r.category_rank ?? ''}</td><td>${r.laps}</td>
      <td style="font-variant-numeric:tabular-nums"><strong>${r.elapsed}</strong></td>
      <td class="muted" style="font-variant-numeric:tabular-nums">${behindOf(r, i)}</td>${eCell(r)}</tr>`).join('');
    const otherRows = others.map((r) => `<tr>
      <td class="muted">–</td><td><strong>${esc(r.bib || '')}</strong></td>
      <td>${nameWithTeam(r)}</td>
      <td>${esc(r.category || '')}</td><td></td><td>${r.laps || ''}</td>
      <td class="muted">${RACE_STATUS_LABEL()[r.status] || r.status}</td><td></td>${eCell(r)}</tr>`).join('');
    return `<div style="overflow-x:auto"><table class="board mt"><thead>
      <tr><th colspan="${editable ? 9 : 8}">${esc(d || t('overall'))}</th></tr>
      <tr><th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('category')}</th>
      <th>${t('category_place')}</th><th>${t('laps')}</th><th>${t('elapsed_col')}</th><th>${t('behind')}</th>${editable ? '<th></th>' : ''}</tr></thead>
      <tbody>${finRows}${otherRows}</tbody></table></div>`;
  }).join('');
  return sections || `<p class="muted">${t('no_results_yet')}</p>`;
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

// Inline "edit every column" form for one racer in the Manage start list.
function racerEditForm(a, waves) {
  const g = a.gender || '';
  return `<form class="racer-edit" style="display:flex;flex-direction:column;gap:6px;width:100%">
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      <input name="bib" value="${esc(a.bib || '')}" placeholder="${t('bib')}" style="width:64px">
      <input name="participant" value="${esc(a.participant || '')}" placeholder="${t('participant')}" style="flex:2;min-width:120px">
      <input name="category" value="${esc(a.category || '')}" placeholder="${t('category')}" style="flex:1;min-width:76px">
      <input name="distance" value="${esc(a.distance || '')}" placeholder="${t('distance')}" style="width:74px">
      <input name="team" value="${esc(a.team || '')}" placeholder="${t('team')}" style="flex:1;min-width:80px">
      <select name="gender" style="width:96px">
        <option value="" ${!g ? 'selected' : ''}>${t('gender_col')} —</option>
        <option value="Male" ${isMaleW(g) ? 'selected' : ''}>${t('male')}</option>
        <option value="Female" ${isFemaleW(g) ? 'selected' : ''}>${t('female')}</option>
      </select>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
      <select name="wave_id" style="flex:1;min-width:110px">
        <option value="">${t('wave')} —</option>
        ${waves.map((w) => `<option value="${w.id}" ${a.wave_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select>
      <select name="racer_status" style="flex:0 0 auto;width:auto">
        ${['', 'DNS', 'DNF', 'DSQ'].map((s) => `<option value="${s}" ${a.racer_status === s ? 'selected' : ''}>${s || t('status_ok')}</option>`).join('')}
      </select>
      <input name="epc" value="${esc((a.epcs && a.epcs[0]) || a.epc || '')}" placeholder="${t('epc_optional')}" pattern="[0-9A-Fa-f]{4,64}" style="flex:1;min-width:130px">
      <input name="epc2" value="${esc((a.epcs && a.epcs[1]) || '')}" placeholder="${t('epc2_optional')}" pattern="[0-9A-Fa-f]{4,64}" style="flex:1;min-width:130px">
    </div>
    <div style="display:flex;gap:6px">
      <button type="button" class="btn small racer-save">${t('save')}</button>
      <button type="button" class="btn small secondary racer-cancel">${t('cancel')}</button>
    </div>
  </form>`;
}

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
    ${c.status === 'finished' ? `
    <div class="card" style="border-inline-start:4px solid var(--accent)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div>
          <strong>${t('status')}: <span class="pill finished">${t('status_finished')}</span></strong>
          <div class="muted" style="font-size:.82rem;margin-top:4px">${t('reopen_help')}</div>
        </div>
        <button class="btn small secondary" id="reopen-race">↩ ${t('reopen_race')}</button>
      </div>
    </div>` : ''}
    <div class="card${c.status === 'finished' ? ' mt' : ''}">
      <h3 style="margin-top:0">📱 ${t('app_pairing')}</h3>
      <p class="muted" style="margin:4px 0">${t('app_pairing_help')}</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <code style="font-size:0.8rem;overflow-wrap:anywhere">${esc(c.app_token || '')}</code>
        <button class="btn small secondary" id="copy-token">${t('copy')}</button>
      </div>
    </div>

    <div class="card mt">
      <h3 style="margin-top:0">🗓 ${t('race_schedule')}</h3>
      <form id="schedule-form" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <label style="margin:0">${t('start_date')}
          <input name="start" type="datetime-local" value="${toLocalInput(c.start_at)}" required style="display:block;margin-top:4px"></label>
        <label style="margin:0">${t('end_date')}
          <input name="end" type="datetime-local" value="${toLocalInput(c.end_at)}" required style="display:block;margin-top:4px"></label>
        <button class="btn small secondary">${t('save_settings')}</button>
      </form>
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
          <div class="comment racer-grid" id="racer-row-${i}">
            <strong>#${esc(a.bib || '—')}</strong>
            <span>${esc(a.participant)}</span>
            <span>${a.category ? `<span class="pill tag">${esc(a.category)}</span>` : ''}</span>
            <span>${a.distance ? `<span class="pill">${esc(a.distance)}</span>` : ''}</span>
            <span class="muted" style="font-size:.8rem">${esc(a.team || '')}</span>
            <span>${a.wave_name ? `<span class="pill">${esc(a.wave_name)}</span>` : ''}</span>
            <code style="font-size:0.7rem;overflow-wrap:anywhere" class="muted">${esc((a.epcs || [a.epc]).join(' + '))}</code>
            <select class="tag-status" data-idx="${i}" aria-label="${t('racer_status')}" style="width:auto;padding:2px 6px">
              ${['', 'DNS', 'DNF', 'DSQ'].map((s) => `<option value="${s}" ${a.racer_status === s ? 'selected' : ''}>${s || t('status_ok')}</option>`).join('')}
            </select>
            <button class="ghost tag-edit" data-idx="${i}" title="${t('edit')}" aria-label="${t('edit')}">✏️</button>
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
          <label style="margin:0;font-weight:400;display:flex;align-items:center;gap:4px">
            <input name="recordlaps" type="checkbox" ${c.record_laps === 0 ? '' : 'checked'} style="width:auto">${t('record_laps_label')}</label>
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

  const reopenBtn = $('#reopen-race');
  if (reopenBtn) reopenBtn.onclick = async () => {
    if (!confirm(t('reopen_confirm'))) return;
    try {
      await api(`/contests/${c.id}/reopen`, { method: 'POST' });
      toast(t('reopened_ok'));
      viewContest(c.id, 'manage'); // re-render with the now-active status
    } catch (err) { toast(err.message, true); }
  };

  const schedForm = $('#schedule-form');
  // Picking a start time defaults the end to start + 1.5h; the user can still
  // adjust the end afterwards.
  schedForm.start.addEventListener('change', () => {
    if (!schedForm.start.value) return;
    const s = new Date(schedForm.start.value);
    if (isNaN(s.getTime())) return;
    schedForm.end.value = toLocalInput(new Date(s.getTime() + 90 * 60 * 1000).toISOString());
  });
  schedForm.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const start = new Date(f.start.value), end = new Date(f.end.value);
    if (isNaN(start) || isNaN(end)) { toast(t('invalid_dates'), true); return; }
    if (end <= start) { toast(t('end_after_start'), true); return; }
    try {
      await api(`/contests/${c.id}`, { method: 'PATCH',
        body: { start_at: start.toISOString(), end_at: end.toISOString() } });
      toast(t('saved'));
      viewContest(c.id, 'manage'); // re-render with the new times
    } catch (err) { toast(err.message, true); }
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
          distance: a.distance, team: a.team, gender: a.gender,
          wave_id: a.wave_id, racer_status: sel.value,
        }});
        toast('✓');
      } catch (err) { toast(err.message, true); }
    };
  });

  // Full inline edit of a racer (all columns).
  box.querySelectorAll('.tag-edit').forEach((btn) => {
    btn.onclick = () => {
      const a = tags[Number(btn.dataset.idx)];
      const row = box.querySelector(`#racer-row-${btn.dataset.idx}`);
      row.classList.remove('racer-grid'); // the edit form lays itself out
      row.innerHTML = racerEditForm(a, waves);
      const f = row.querySelector('.racer-edit');
      row.querySelector('.racer-cancel').onclick = () => viewContest(c.id, 'manage');
      row.querySelector('.racer-save').onclick = async () => {
        const participant = f.participant.value.trim();
        if (!participant) return toast(t('epc_or_bib'), true);
        const bib = f.bib.value.trim();
        const newEpc = (f.epc.value.trim() || (/^\d{1,10}$/.test(bib) ? 'AA' + bib.padStart(4, '0') : '')).toUpperCase();
        const newEpc2 = f.epc2.value.trim().toUpperCase();
        if (!newEpc) return toast(t('epc_or_bib'), true);
        const oldSet = new Set((a.epcs || [a.epc]).map((x) => x.toUpperCase()));
        const newSet = new Set([newEpc, ...(newEpc2 ? [newEpc2] : [])]);
        const sameChips = oldSet.size === newSet.size && [...oldSet].every((x) => newSet.has(x));
        try {
          // Changing the chip(s) means a new identity: drop the old racer first.
          if (!sameChips) await api(`/contests/${c.id}/tags/${a.epc}`, { method: 'DELETE' });
          await api(`/contests/${c.id}/tags`, { method: 'POST', body: {
            epc: newEpc, epc2: newEpc2, bib, participant,
            category: f.category.value.trim(), distance: f.distance.value.trim(),
            team: f.team.value.trim(), gender: f.gender.value,
            wave_id: f.wave_id.value ? Number(f.wave_id.value) : null,
            racer_status: f.racer_status.value,
          }});
          viewContest(c.id, 'manage');
        } catch (err) { toast(err.message, true); }
      };
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
        record_laps: e.target.recordlaps.checked,
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

// ---------- league standings ----------

// League management for the signed-in user (their own leagues + own races).
async function viewMyLeagues() {
  if (!state.user) { location.hash = '#/login'; return; }
  main.innerHTML = `
    <div class="brand-row">
      <img class="hero-logo" src="${BASE}/velogrip-logo.png" alt="VeloGrip" width="739" height="553">
      <h1 class="page-title-center">${t('my_leagues_title')}</h1>
    </div>
    <div id="ml-box"></div>`;
  await renderLeagueManager(document.getElementById('ml-box'), 'mine', viewMyLeagues);
}

async function viewLeagues() {
  const { leagues } = await api('/leagues');
  main.innerHTML = `
    <div class="brand-row">
      <img class="hero-logo" src="${BASE}/velogrip-logo.png" alt="VeloGrip" width="739" height="553">
      <h1 class="page-title-center">${t('leagues_title')}</h1>
    </div>
    ${state.user ? `<div style="text-align:center;margin:0 0 18px">
      <a class="btn secondary" href="#/myleagues">➕ ${t('my_leagues_title')}</a></div>` : ''}
    ${leagues.length ? `<div class="grid">${leagues.map((l) => {
      const allRacesDone = l.race_count > 0 && l.finished_race_count === l.race_count;
      const isFinished = l.status === 'finished' || allRacesDone;
      return `
      <a class="card contest-card" href="#/league/${l.id}">
        <div class="card-pills">
          ${l.sport ? `<span class="pill">🏁 ${esc(sportLabel(l.sport))}</span>` : ''}
          <span class="pill ${isFinished ? 'finished' : 'live'}">${isFinished ? t('status_finished') : t('status_active')}</span>
        </div>
        <h3>${esc(l.name)}</h3>
        <div class="meta">
          ${l.location ? `<span>📍 ${esc(l.location)}</span>` : ''}
          <span>${l.season ? esc(l.season) + ' · ' : ''}${t('league_races_finished', { done: l.finished_race_count, total: l.race_count })}</span>
          <span>👥 ${l.racer_count} ${t('racers')}</span>
        </div>
      </a>`;
    }).join('')}</div>` : `<p class="muted">${t('league_no_leagues')}</p>`}`;
}

async function viewLeague(id, tab) {
  const data = await api(`/leagues/${id}/standings`).catch(() => null);
  if (!data) { main.innerHTML = `<div class="card">${t('league_not_found')}</div>`; return; }
  const { league, races, individual, teams, meta } = data;
  currentLeague = data; // drives the team-members / racer detail modals
  const provisional = races.some((r) => r.status !== 'finished');

  const tabs = [['teams', 'league_tab_teams'], ['individual', 'league_tab_individual'], ['races', 'league_tab_races']];
  main.innerHTML = `
    <div class="pubresults">
      <h1 style="text-align:center;margin-bottom:2px">${esc(league.name)}</h1>
      <p style="text-align:center;margin:0 0 12px;color:var(--muted)">
        ${league.season ? esc(league.season) + ' — ' : ''}${t('league_rounds_count', { n: races.length })}
        ${provisional ? ` · ${t('league_provisional')}` : ''}</p>
      ${meta ? leagueInfoPanel(league, meta) : ''}
      <div class="pubtabs">
        ${tabs.map(([k, key]) => `<a class="pubtab ${tab === k ? 'active' : ''}" href="#/league/${id}/${k}">${t(key)}</a>`).join('')}
      </div>
      <div style="text-align:center;margin:8px 0">
        <button class="btn small secondary" id="lg-csv-ind">⬇ ${t('export_individual_csv')}</button>
        <button class="btn small secondary" id="lg-csv-team">⬇ ${t('export_team_csv')}</button>
      </div>
      ${tab === 'races' ? '' : `<p class="muted" style="text-align:center;margin:0 0 8px;font-size:12.5px">${t('league_view_hint')}</p>`}
      <div id="lgbody"></div>
    </div>`;
  document.getElementById('lg-csv-ind').onclick = () =>
    downloadAuthed(`/leagues/${id}/standings?format=csv&table=individual`, `league-${id}-individual.csv`);
  document.getElementById('lg-csv-team').onclick = () =>
    downloadAuthed(`/leagues/${id}/standings?format=csv&table=team`, `league-${id}-team.csv`);

  const body = document.getElementById('lgbody');
  if (tab === 'teams') body.innerHTML = leagueTeamsTable(teams, races);
  else if (tab === 'races') body.innerHTML = leagueRacesTable(races);
  else body.innerHTML = leagueIndividualTables(individual, races);
  wireLeagueLinks(body); // clickable racer / team names -> detail modals
}

// Per-race columns shared by the individual and team standings tables. Cells
// whose score is dropped (not among the best-N counted) render muted.
function leagueRoundHeads(races) {
  return races.map((r) => `<th title="${esc(r.title)}"><a href="#/results/${r.contest_id}" style="color:inherit">R${r.round}</a></th>`).join('');
}
function leaguePointCells(row, races) {
  return races.map((r) => {
    const pts = row.per_race[r.contest_id];
    if (pts === undefined) return '<td class="muted">–</td>';
    const counted = row.counted_ids.includes(r.contest_id);
    return `<td style="font-variant-numeric:tabular-nums${counted ? '' : ';opacity:.45;text-decoration:line-through'}">${pts}</td>`;
  }).join('');
}

function leagueIndividualTables(individual, races) {
  if (!individual.length) return `<p class="muted">${t('league_no_scores')}</p>`;
  let html = '';
  for (const g of individual) {
    const title = [g.distance, g.gender && t(g.gender === 'Female' ? 'female' : 'male'), g.category]
      .filter(Boolean).join(' — ') || t('overall');
    html += `<div style="overflow-x:auto"><table class="board winners mt"><thead>
      <tr><th colspan="${4 + races.length + 1}">${esc(title)}</th></tr>
      <tr><th>${t('place')}</th><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('team')}</th>
        ${leagueRoundHeads(races)}<th>${t('league_total')}</th></tr></thead>
      <tbody>${g.rows.map((row, i) => `<tr class="${i < 3 ? 'top' + (i + 1) : ''}">
        <td><strong>${i + 1}</strong></td><td><strong>${esc(row.bib)}</strong></td>
        <td>${racerLink(row.bib, row.name || row.bib)}</td><td>${teamLink(row.team)}</td>
        ${leaguePointCells(row, races)}
        <td><strong style="font-variant-numeric:tabular-nums">${row.total}</strong></td></tr>`).join('')}</tbody></table></div>`;
  }
  html += `<p class="muted" style="font-size:12.5px">${t('league_dropped_note')}</p>`;
  return html;
}

function leagueTeamsTable(teams, races) {
  if (!teams.length) return `<p class="muted">${t('league_no_scores')}</p>`;
  return `<div style="overflow-x:auto"><table class="board winners mt"><thead>
    <tr><th>${t('place')}</th><th>${t('team')}</th>${leagueRoundHeads(races)}<th>${t('league_total')}</th></tr></thead>
    <tbody>${teams.map((row, i) => `<tr class="${i < 3 ? 'top' + (i + 1) : ''}">
      <td><strong>${i + 1}</strong></td><td>${teamLink(row.team)}</td>
      ${leaguePointCells(row, races)}
      <td><strong style="font-variant-numeric:tabular-nums">${row.total}</strong></td></tr>`).join('')}</tbody></table></div>
    <p class="muted" style="font-size:12.5px">${t('league_dropped_note')}</p>`;
}

// A league race's live status: finished, active (now within the event window),
// scheduled (before it starts) or awaiting results (window passed, not posted).
function leagueRaceStatus(r) {
  if (r.status === 'finished') return { cls: 'finished', label: t('status_finished') };
  const now = Date.now();
  const start = new Date(r.start_at).getTime();
  const end = r.end_at ? new Date(r.end_at).getTime() : start;
  if (now >= start && now <= end) return { cls: 'live', label: t('league_race_active') };
  if (now < start) return { cls: 'tag', label: t('league_race_scheduled') };
  return { cls: 'awaiting', label: t('league_race_awaiting') };
}

function leagueRacesTable(races) {
  if (!races.length) return `<p class="muted">${t('league_no_races_attached')}</p>`;
  return `<div style="overflow-x:auto"><table class="board mt"><thead>
    <tr><th>${t('league_round_col')}</th><th>${t('race_word')}</th><th>${t('date_word')}</th><th>${t('status_word')}</th></tr></thead>
    <tbody>${races.map((r) => {
      const s = leagueRaceStatus(r);
      return `<tr>
      <td><strong>R${r.round}</strong></td>
      <td><a href="#/results/${r.contest_id}">${esc(r.title)}</a></td>
      <td>${fmtDate(r.start_at)}</td>
      <td><span class="pill ${s.cls}">${s.label}</span></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

// ---------- league detail modals ----------
// The standings payload already carries every rider (bib/name/team/per_race/
// total) and each team's totals, so team-roster and racer season-card views are
// built entirely client-side from `currentLeague` — no extra API calls.

let currentLeague = null; // {league, races, individual, teams} of the open league page

function racerLink(bib, label) {
  if (!bib) return esc(label || ''); // no bib -> not tracked across the season, not clickable
  return `<a class="lglink" role="button" tabindex="0" data-racer="${esc(bib)}">${esc(label || bib)}</a>`;
}
function teamLink(team) {
  const name = String(team || '').trim();
  if (!name) return '';
  return `<a class="lglink" role="button" tabindex="0" data-team="${esc(name)}">${esc(name)}</a>`;
}

// Label for an individual scoring group (distance — gender — category).
function groupLabelOf(g) {
  return [g.distance, g.gender && t(g.gender === 'Female' ? 'female' : 'male'), g.category]
    .filter(Boolean).join(' — ') || t('overall');
}

// Delegate clicks/keydowns on racer & team links within a container to the modals.
function wireLeagueLinks(container) {
  container.addEventListener('click', (e) => {
    const el = e.target.closest('[data-racer],[data-team]');
    if (!el) return;
    e.preventDefault();
    if (el.dataset.racer) openRacerModal(el.dataset.racer);
    else openTeamModal(el.dataset.team);
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[data-racer],[data-team]');
    if (!el) return;
    e.preventDefault();
    if (el.dataset.racer) openRacerModal(el.dataset.racer);
    else openTeamModal(el.dataset.team);
  });
}

function closeModal() {
  const ex = document.getElementById('modal-root');
  if (ex) ex.remove();
}

// onBack (optional): when the modal was reached by drilling in (racer -> team ->
// racer …), a "back" button in the header returns to the previous card.
function openModal(title, bodyHtml, onBack) {
  closeModal(); // one modal at a time; opening a team from a racer card replaces it
  const backGlyph = LANG === 'he' ? '→' : '←';
  const backBtn = onBack ? `<button class="modal-back" aria-label="${t('back')}">${backGlyph} ${t('back')}</button>` : '';
  const root = document.createElement('div');
  root.id = 'modal-root';
  root.className = 'modal-backdrop';
  root.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">${backBtn}<h3>${title}</h3>
        <button class="modal-close" aria-label="${t('close')}">✕</button></div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(root);
  root.addEventListener('click', (e) => { if (e.target === root) closeModal(); });
  root.querySelector('.modal-close').onclick = closeModal;
  if (onBack) root.querySelector('.modal-back').onclick = () => onBack();
  // Following a race link navigates away, so drop the modal first.
  root.querySelectorAll('a[href^="#/"]').forEach((a) => a.addEventListener('click', closeModal));
  return root;
}

// Wire the racer/team drill-in links inside a modal, passing `backToSelf` so the
// opened card can return here. (Standings tables use wireLeagueLinks, top-level.)
function wireModalLinks(root, backToSelf) {
  const go = (el) => {
    if (el.dataset.racer) openRacerModal(el.dataset.racer, backToSelf);
    else if (el.dataset.team) openTeamModal(el.dataset.team, backToSelf);
  };
  root.querySelectorAll('[data-racer],[data-team]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); go(el); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(el); } });
  });
}

// Team roster: every scoring member of `team`, with their category and season total.
// `back` (optional): reopen the card we drilled in from.
function openTeamModal(team, back) {
  if (!currentLeague) return;
  const members = [];
  for (const g of currentLeague.individual) {
    const group = groupLabelOf(g);
    g.rows.forEach((row) => {
      if (String(row.team || '').trim() === team) members.push({ ...row, group });
    });
  }
  members.sort((a, b) => b.total - a.total);
  const teamRow = currentLeague.teams.find((x) => x.team === team);
  const rank = teamRow ? currentLeague.teams.indexOf(teamRow) + 1 : null;
  const summary = teamRow
    ? `<p class="muted" style="margin:0 0 10px">${t('league_rank')}: <strong>${rank}</strong> · ${t('league_total')}: <strong>${teamRow.total}</strong></p>`
    : '';
  const html = members.length
    ? `${summary}<div style="overflow-x:auto"><table class="board mt"><thead>
        <tr><th>${t('bib')}</th><th>${t('participant')}</th><th>${t('category')}</th><th>${t('league_total')}</th></tr></thead>
        <tbody>${members.map((m) => `<tr>
          <td><strong>${esc(m.bib)}</strong></td>
          <td>${racerLink(m.bib, m.name || m.bib)}</td>
          <td>${esc(m.group)}</td>
          <td style="font-variant-numeric:tabular-nums"><strong>${m.total}</strong></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${t('league_no_members')}</p>`;
  // Always offer Back: to the card we came from, or to the standings (close).
  const root = openModal(`👥 ${esc(team)}`, html, back || closeModal);
  wireModalLinks(root, () => openTeamModal(team, back)); // members -> racer card, back here
}

// Racer season card: their group + rank + total, then points earned per race.
// `back` (optional): reopen the card we drilled in from.
function openRacerModal(bib, back) {
  if (!currentLeague) return;
  let rider = null, group = null, rank = null;
  for (const g of currentLeague.individual) {
    const idx = g.rows.findIndex((r) => r.bib === bib);
    if (idx >= 0) { rider = g.rows[idx]; group = g; rank = idx + 1; break; }
  }
  if (!rider) return;
  const teamHtml = rider.team ? teamLink(rider.team) : '<span class="muted">—</span>';
  const header = `<p class="muted" style="margin:0 0 10px">
      ${t('bib')} <strong>${esc(rider.bib)}</strong> · ${esc(groupLabelOf(group))} · ${t('team')}: ${teamHtml}<br>
      ${t('league_rank')}: <strong>${rank}</strong> · ${t('league_total')}: <strong>${rider.total}</strong></p>`;
  const rows = currentLeague.races.map((r) => {
    const pts = rider.per_race[r.contest_id];
    const has = pts !== undefined;
    const counted = has && rider.counted_ids.includes(r.contest_id);
    const style = 'font-variant-numeric:tabular-nums' + (has && !counted ? ';opacity:.45;text-decoration:line-through' : '');
    return `<tr>
      <td><strong>R${r.round}</strong></td>
      <td><a href="#/results/${r.contest_id}">${esc(r.title)}</a></td>
      <td style="${style}">${has ? pts : '–'}</td></tr>`;
  }).join('');
  const table = `<div style="overflow-x:auto"><table class="board mt"><thead>
      <tr><th>${t('league_round_col')}</th><th>${t('race_word')}</th><th>${t('league_points')}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="muted" style="font-size:12.5px">${t('league_dropped_note')}</p>`;
  // Always offer Back: to the card we came from, or to the standings (close).
  const root = openModal(`🏃 ${esc(rider.name || rider.bib)}`, header + table, back || closeModal);
  wireModalLinks(root, () => openRacerModal(bib, back)); // team link -> team card, back here
}

// Global dismissals: Esc closes, and any route change tears the modal down.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('hashchange', closeModal);

// ---------- admin ----------

async function viewAdmin(section) {
  if (!state.user || state.user.role !== 'admin') { main.innerHTML = `<div class="card">${t('need_login')}</div>`; return; }
  main.innerHTML = `
    <div class="tabs" role="tablist">
      ${['leagues', 'users', 'audit'].map((s) => `<button role="tab" aria-selected="${s === section}" data-s="${s}">${t('admin_' + s)}</button>`).join('')}
    </div>
    <div id="admin-box"></div>`;
  main.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => { location.hash = `#/admin/${b.dataset.s}`; }));
  const box = document.getElementById('admin-box');

  if (section === 'users') {
    const { users } = await api('/admin/users');
    const pending = users.filter((u) => !u.approved);
    const pendingHtml = `
      <div class="card mt">
        <h3 style="margin-top:0">${t('pending_registrations')}${pending.length ? ` <span class="pill tag">${pending.length}</span>` : ''}</h3>
        ${pending.length ? `<div style="overflow-x:auto"><table class="board">
          <thead><tr><th>${t('display_name')}</th><th>${t('email')}</th><th>${t('start_date')}</th><th></th></tr></thead>
          <tbody>${pending.map((u) => `
            <tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td class="muted">${fmtDate(u.created_at)}</td>
            <td style="white-space:nowrap;display:flex;gap:6px">
              <button class="btn small" data-approve="${u.id}">${t('approve')}</button>
              <button class="btn small danger" data-reject="${u.id}" data-name="${esc(u.name)}">${t('reject')}</button>
            </td></tr>`).join('')}</tbody></table></div>`
          : `<p class="muted" style="margin:0">${t('no_pending_registrations')}</p>`}
      </div>`;
    box.innerHTML = pendingHtml + `<div class="card mt" style="overflow-x:auto"><table class="board">
      <thead><tr><th>ID</th><th>${t('display_name')}</th><th>${t('email')}</th><th>Role</th><th>Rep</th><th></th></tr></thead>
      <tbody>${users.filter((u) => u.approved).map((u) => `
        <tr><td>${u.id}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role}</td><td>${u.reputation}</td>
        <td style="white-space:nowrap;display:flex;gap:6px;justify-content:flex-end">
          <button class="btn small ${u.is_banned ? 'secondary' : 'danger'}" data-ban="${u.id}" data-to="${u.is_banned ? 0 : 1}">${u.is_banned ? 'Unban' : t('ban_user')}</button>
          ${u.role === 'admin' ? '' : `<button class="btn small danger" data-del="${u.id}" data-name="${esc(u.name)}">${t('delete_user')}</button>`}
        </td></tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.onclick = async () => {
        try { await api(`/admin/users/${btn.dataset.approve}/approve`, { method: 'POST' }); toast(t('user_approved')); viewAdmin('users'); }
        catch (err) { toast(err.message, true); }
      };
    });
    box.querySelectorAll('[data-reject]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(t('reject_confirm', { name: btn.dataset.name }))) return;
        try { await api(`/admin/users/${btn.dataset.reject}/reject`, { method: 'POST' }); viewAdmin('users'); }
        catch (err) { toast(err.message, true); }
      };
    });
    box.querySelectorAll('[data-ban]').forEach((btn) => {
      btn.onclick = async () => {
        await api(`/admin/users/${btn.dataset.ban}/ban`, { method: 'POST', body: { banned: btn.dataset.to === '1' } });
        viewAdmin('users');
      };
    });
    box.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(t('delete_user_confirm', { name: btn.dataset.name }))) return;
        try { await api(`/admin/users/${btn.dataset.del}`, { method: 'DELETE' }); toast(t('user_deleted')); viewAdmin('users'); }
        catch (err) { toast(err.message, true); }
      };
    });
  } else if (section === 'leagues') {
    await renderLeagueManager(box, 'admin', () => viewAdmin('leagues'));
  } else {
    const { audit_log } = await api('/admin/audit-log');
    box.innerHTML = `<div class="card mt" style="overflow-x:auto"><table class="board">
      <thead><tr><th>#</th><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>Time</th></tr></thead>
      <tbody>${audit_log.map((a) => `
        <tr><td>${a.id}</td><td>${esc(a.user_name || '—')}</td><td><code>${esc(a.action)}</code></td>
        <td>${esc(a.target_type)} ${a.target_id ?? ''}</td><td>${esc(a.details)}</td><td class="muted">${fmtDate(a.created_at)}</td></tr>`).join('')}</tbody></table></div>`;
  }
}

// League manager — create leagues, attach races as rounds, tune scoring rules.
// scope 'admin' manages every league and can attach any race; scope 'mine'
// manages only the current user's leagues and offers only their own races.
// refresh() re-renders after a mutation.
async function renderLeagueManager(box, scope, refresh) {
  const mine = scope === 'mine';
  const [{ leagues: allLeagues }, racesResp] = await Promise.all([
    api('/leagues?status=all'), // admin sees archived leagues too
    mine ? api('/my/races') : api('/contests'),
  ]);
  const leagues = mine ? allLeagues.filter((l) => l.created_by === state.user.id) : allLeagues;
  const allRaces = mine ? (racesResp.races || []) : (racesResp.contests || []).filter((c) => c.kind === 'race');

  box.innerHTML = `
    <div class="card mt form-narrow">
      <h3>${t('league_create')}</h3>
      <form id="lg-new">
        <label>${t('league_name')}<input id="lg-name" required></label>
        <label>${t('league_season')}<input id="lg-season" placeholder="2026"></label>
        <label>${t('league_preset')}<select id="lg-preset">
          <option value="running">${t('league_preset_running')}</option>
          <option value="mtb">${t('league_preset_mtb')}</option>
        </select></label>
        <button class="btn">${t('league_create')}</button>
      </form>
    </div>
    <div id="lg-list"></div>`;

  document.getElementById('lg-new').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/leagues', { method: 'POST', body: {
        name: document.getElementById('lg-name').value,
        season: document.getElementById('lg-season').value,
        preset: document.getElementById('lg-preset').value,
      }});
      toast(t('league_saved'));
      refresh();
    } catch (err) { toast(err.message, true); }
  };

  const list = document.getElementById('lg-list');
  if (!leagues.length) { list.innerHTML = `<p class="muted mt">${t('league_no_leagues')}</p>`; return; }

  // Fetch every league's races once, and collect the contest ids attached to
  // ANY league so the attach dropdown only offers races not yet in a league.
  const details = await Promise.all(leagues.map((row) => api(`/leagues/${row.id}`)));
  const attachedAnywhere = new Set(details.flatMap((d) => d.races.map((r) => r.contest_id)));
  // contest_id -> which league it's in (for the grouped attach picker).
  const membership = new Map();
  for (const d of details) for (const r of d.races) {
    membership.set(r.contest_id, { leagueId: d.league.id, leagueName: d.league.name, round: r.round });
  }

  for (const { league, races } of details) {
    const attachable = allRaces.filter((c) => !attachedAnywhere.has(c.id));
    // Grouped <select>: free start lists (selectable) first, then a disabled
    // group per OTHER league showing where each taken race already went.
    const freeOpts = attachable.length
      ? attachable.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join('')
      : `<option value="" disabled>${t('league_no_attachable')}</option>`;
    const takenByLeague = new Map();
    for (const [cid, m] of membership) {
      if (m.leagueId === league.id) continue; // its own races are in the rounds table above
      const race = allRaces.find((c) => c.id === cid);
      if (!race) continue;
      if (!takenByLeague.has(m.leagueName)) takenByLeague.set(m.leagueName, []);
      takenByLeague.get(m.leagueName).push(
        `<option value="${cid}" disabled>${esc(race.title)} · R${m.round}</option>`);
    }
    const takenGroups = [...takenByLeague.entries()].map(([name, opts]) =>
      `<optgroup label="${esc(t('league_group_in') + ' ' + name)}">${opts.join('')}</optgroup>`).join('');
    const contestOptions = `<optgroup label="${esc(t('league_group_free'))}">${freeOpts}</optgroup>${takenGroups}`;
    const s = league.settings;
    const card = document.createElement('div');
    card.className = 'card mt';
    card.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <h3 style="margin:0"><a href="#/league/${league.id}">${esc(league.name)}</a></h3>
        <span class="muted">${esc(league.season || '')}</span>
        <select data-f="status">
          ${['active', 'finished', 'archived'].map((st) => `<option value="${st}" ${league.status === st ? 'selected' : ''}>${st}</option>`).join('')}
        </select>
        <button class="btn small danger" data-act="delete" style="margin-inline-start:auto">${t('delete')}</button>
      </div>

      <table class="board mt"><thead><tr><th>${t('league_round_col')}</th><th>${t('race_word')}</th><th>${t('status_word')}</th><th></th></tr></thead>
      <tbody>${races.map((r) => `<tr>
        <td><input type="number" min="1" value="${r.round}" data-round="${r.contest_id}" style="width:60px"></td>
        <td>${esc(r.title)}${r.visibility !== 'public' ? ` <span class="pill tag">${t('visibility_private')}</span>` : ''}</td>
        <td>${r.status}</td>
        <td><button class="btn small secondary" data-detach="${r.contest_id}">${t('league_detach')}</button></td></tr>`).join('')
        || `<tr><td colspan="4" class="muted">${t('league_no_races_attached')}</td></tr>`}</tbody></table>

      <form data-form="attach" class="mt" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select data-f="contest">${contestOptions}</select>
        <button class="btn small" ${attachable.length ? '' : 'disabled'}>${t('league_attach')}</button>
        <span class="muted" style="font-size:12px">${t('league_attach_hint')}</span>
      </form>

      <details class="mt"><summary>${t('league_settings')}</summary>
        <form data-form="settings" class="mt" style="display:grid;gap:6px;max-width:460px">
          <label>${t('league_ind_points')}<input data-f="individual_points" value="${s.individual_points.join(', ')}"></label>
          <label>${t('league_ind_other_points')}<input data-f="individual_other_points" type="number" min="0" value="${s.individual_other_points}"></label>
          <label>${t('league_ind_best_n')}<input data-f="individual_best_n" type="number" min="1" value="${s.individual_best_n}"></label>
          <label>${t('league_team_mode')}<select data-f="team_scoring_mode">
            ${['category', 'overall'].map((m) => `<option value="${m}" ${s.team_scoring_mode === m ? 'selected' : ''}>${t('league_team_mode_' + m)}</option>`).join('')}
          </select></label>
          <label data-mode-field="category">${t('league_team_points')}<input data-f="team_points" value="${s.team_points.join(', ')}"></label>
          <label data-mode-field="overall">${t('league_team_overall_start')}<input data-f="team_overall_start" type="number" min="1" value="${s.team_overall_start}"></label>
          <label><span data-otherpoints-label>${t('league_team_other_points')}</span><input data-f="team_other_points" type="number" min="0" value="${s.team_other_points}"></label>
          <label><span data-toprunners-label>${t('league_team_top_runners')}</span><input data-f="team_top_runners" type="number" min="1" value="${s.team_top_runners}"></label>
          <label>${t('league_team_best_n')}<input data-f="team_best_n" type="number" min="1" value="${s.team_best_n}"></label>
          <span class="muted" style="font-size:12px">${t('league_team_mode_hint')}</span>
          <button class="btn small">${t('save')}</button>
        </form>
      </details>`;

    card.querySelector('[data-f="status"]').onchange = async (e) => {
      try { await api(`/leagues/${league.id}`, { method: 'PATCH', body: { status: e.target.value } }); toast(t('league_saved')); }
      catch (err) { toast(err.message, true); }
    };
    card.querySelector('[data-act="delete"]').onclick = async () => {
      if (!confirm(t('league_confirm_delete', { name: league.name }))) return;
      try { await api(`/leagues/${league.id}`, { method: 'DELETE' }); toast(t('league_deleted')); refresh(); }
      catch (err) { toast(err.message, true); }
    };
    card.querySelectorAll('[data-detach]').forEach((btn) => {
      btn.onclick = async () => {
        try { await api(`/leagues/${league.id}/races/${btn.dataset.detach}`, { method: 'DELETE' }); refresh(); }
        catch (err) { toast(err.message, true); }
      };
    });
    card.querySelectorAll('[data-round]').forEach((inp) => {
      inp.onchange = async () => {
        try {
          await api(`/leagues/${league.id}/races/${inp.dataset.round}`, { method: 'PATCH', body: { round: Number(inp.value) } });
          toast(t('league_saved'));
        } catch (err) { toast(err.message, true); }
      };
    });
    const attachForm = card.querySelector('[data-form="attach"]');
    if (attachForm) attachForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/leagues/${league.id}/races`, { method: 'POST',
          body: { contest_id: Number(attachForm.querySelector('[data-f="contest"]').value) } });
        refresh();
      } catch (err) { toast(err.message, true); }
    };
    // Show only the team-points field that applies to the selected mode.
    const settingsForm = card.querySelector('[data-form="settings"]');
    const modeSel = settingsForm.querySelector('[data-f="team_scoring_mode"]');
    const topLabel = settingsForm.querySelector('[data-toprunners-label]');
    const otherLabel = settingsForm.querySelector('[data-otherpoints-label]');
    const applyMode = () => {
      settingsForm.querySelectorAll('[data-mode-field]').forEach((el) => {
        el.style.display = el.dataset.modeField === modeSel.value ? '' : 'none';
      });
      // Overall mode is the MTB model — count "riders"; category mode counts "runners".
      if (topLabel) topLabel.textContent = t(modeSel.value === 'overall' ? 'league_team_top_riders' : 'league_team_top_runners');
      // In overall mode team_other_points is the floor; in category mode it's the
      // fallback for finishers placed beyond the ranked list.
      if (otherLabel) otherLabel.textContent = t(modeSel.value === 'overall' ? 'league_team_other_points_overall' : 'league_team_other_points');
    };
    modeSel.onchange = applyMode;
    applyMode();

    settingsForm.onsubmit = async (e) => {
      e.preventDefault();
      const f = (name) => e.target.querySelector(`[data-f="${name}"]`).value;
      const nums = (v) => v.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
      try {
        await api(`/leagues/${league.id}`, { method: 'PATCH', body: { settings: {
          individual_points: nums(f('individual_points')),
          individual_other_points: Number(f('individual_other_points')),
          individual_best_n: Number(f('individual_best_n')),
          team_scoring_mode: f('team_scoring_mode'),
          team_points: nums(f('team_points')),
          team_overall_start: Number(f('team_overall_start')),
          team_other_points: Number(f('team_other_points')),
          team_top_runners: Number(f('team_top_runners')),
          team_best_n: Number(f('team_best_n')),
        }}});
        toast(t('league_saved'));
      } catch (err) { toast(err.message, true); }
    };
    list.appendChild(card);
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
// Keep the nav's live ● in sync from any page (the Live tab drives its own
// refresh while open; this covers everywhere else).
refreshLiveDot();
setInterval(() => { if (!livePollTimer) refreshLiveDot(); }, 30000);

// ============================================================
// Zah Hood Central - panel shell + router
// ============================================================
import {
  state, el, clear, api, toast, errMessage, can, connectSocket, on, reportRoute,
} from './core.js';
import { dashboardView } from './views-game.js';
import { playersView, playerView, punishmentsView, serversView, serverView } from './views-db.js';
import { chatView, staffView, keysView, auditView, appealsView } from './views-team.js';
import { accessView } from './views-access.js';
import { permissionsView } from './views-perms.js';
import { trafficView, visitorView } from './views-traffic.js';
import { chatmodView } from './views-chatmod.js';

const ROUTES = {
  '': { title: 'Dashboard', render: dashboardView },
  'players': { title: 'Player Database', render: playersView },
  'player': { title: 'Player', render: playerView },
  'punishments': { title: 'Punishments', render: punishmentsView },
  'servers': { title: 'Live Servers', render: serversView },
  'server': { title: 'Server', render: serverView },
  'chat': { title: 'Staff Chat', render: chatView, flush: true },
  'appeals': { title: 'Ban Appeals', render: appealsView },
  'chatmod': { title: 'Chat Moderation', render: chatmodView },
  'staff': { title: 'Staff Team', render: staffView },
  'keys': { title: 'Game Connection', render: keysView },
  'access': { title: 'Access & Security', render: accessView },
  'permissions': { title: 'Rank Permissions', render: permissionsView },
  'traffic': { title: 'Website Traffic', render: trafficView },
  'visitor': { title: 'Visitor', render: visitorView },
  'audit': { title: 'Audit Log', render: auditView },
};

const NAV = [
  {
    label: 'Overview',
    items: [
      { href: '#/', ico: '◆', text: 'Dashboard', perm: 'stats.view' },
      { href: '#/servers', ico: '☷', text: 'Live Servers', perm: 'servers.view' },
    ],
  },
  {
    label: 'Moderation',
    items: [
      { href: '#/players', ico: '▦', text: 'Player Database', perm: 'db.view' },
      { href: '#/punishments', ico: '⛔', text: 'Punishments', perm: 'db.view' },
      { href: '#/appeals', ico: '⚖', text: 'Appeals', perm: 'appeals.review', badge: 'pendingAppeals' },
      { href: '#/chatmod', ico: '♪', text: 'Chat Moderation', perm: 'chatmod.view' },
    ],
  },
  {
    label: 'Team',
    items: [
      { href: '#/chat', ico: '●', text: 'Staff Chat', perm: 'chat.read' },
      { href: '#/staff', ico: '⚑', text: 'Staff Team', perm: 'staff.view' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '#/keys', ico: '⚯', text: 'Game Connection', perm: 'apikeys.view' },
      { href: '#/access', ico: '⚿', text: 'Access & Security', perm: 'whitelist.view' },
      { href: '#/permissions', ico: '☑', text: 'Rank Permissions', perm: 'roles.permissions' },
      { href: '#/traffic', ico: '◉', text: 'Website Traffic', perm: 'traffic.view' },
      { href: '#/audit', ico: '≡', text: 'Audit Log', perm: 'audit.view' },
    ],
  },
];

let currentCleanup = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: name || '', arg: rest.join('/') };
}

async function boot() {
  const root = document.getElementById('root');

  let me;
  try {
    me = await api('/me');
  } catch (err) {
    if (err.message === 'not_authenticated') return;
    root.innerHTML = `<div class="landing"><div class="landing-card"><h1>Panel unavailable</h1><p class="tagline">${errMessage(err)}</p></div></div>`;
    return;
  }

  state.me = me.user;

  if (!me.staff) {
    clear(root).append(notStaffScreen());
    return;
  }

  state.meta = await api('/meta');
  connectSocket();

  clear(root).append(shell());
  on('stats', () => refreshBadges());
  on('_status', (up) => {
    const dot = document.getElementById('live-dot');
    if (dot) dot.className = `live-dot ${up ? 'on' : ''}`;
    const label = document.getElementById('live-label');
    if (label) label.textContent = up ? 'Live' : 'Reconnecting...';
  });

  window.addEventListener('hashchange', route);
  route();

  // Keep the sidebar counters fresh even on views that do not poll.
  try {
    const s = await api('/stats/live');
    state.stats = s.stats;
    state.staffOnline = s.staffOnline;
    refreshBadges();
  } catch { /* the dashboard will retry */ }
}

function notStaffScreen() {
  return el(
    'main',
    { class: 'landing' },
    el(
      'div',
      { class: 'landing-card' },
      el('div', { class: 'brand-mark' }, el('span', { class: 'glyph' }, 'ZH')),
      el('h1', {}, `Hey ${state.me.username}`),
      el('p', { class: 'tagline' }, 'Your Discord is linked, but you are not on the staff team yet.'),
      el(
        'div',
        { class: 'alert', style: { background: 'rgba(74,168,255,.08)', borderColor: 'rgba(74,168,255,.3)', color: '#a9d4ff' } },
        'Ask a Co-Owner, the Creator or the Game Owner to give you a role in the Staff Team page. Once they do, refresh this page.'
      ),
      el('p', { class: 'note' }, 'Banned from the game? ', el('a', { href: '/appeal' }, 'File an appeal instead'), '.'),
      el('p', { class: 'note' }, el('a', { href: '/auth/logout' }, 'Sign out'))
    )
  );
}

function shell() {
  const me = state.me;

  const nav = el('nav', { class: 'nav' });
  for (const group of NAV) {
    const items = group.items.filter((i) => !i.perm || can(i.perm));
    if (!items.length) continue;
    const g = el('div', { class: 'nav-group' }, el('div', { class: 'nav-label' }, group.label));
    for (const item of items) {
      g.append(
        el(
          'a',
          { href: item.href, dataset: { route: item.href } },
          el('span', { class: 'ico' }, item.ico),
          item.text,
          item.badge ? el('span', { class: 'badge', dataset: { badge: item.badge }, style: { display: 'none' } }, '0') : null
        )
      );
    }
    nav.append(g);
  }

  const sidebar = el(
    'aside',
    { class: 'sidebar' },
    el(
      'div',
      { class: 'sidebar-head' },
      el('span', { class: 'glyph' }, 'ZH'),
      el('div', {}, el('div', { class: 'name' }, 'Zah Hood'), el('div', { class: 'sub' }, 'Central'))
    ),
    nav,
    el(
      'div',
      { class: 'sidebar-foot' },
      el('img', { src: me.avatar, alt: '' }),
      el(
        'div',
        { class: 'who' },
        el('b', {}, me.username),
        el('span', { style: { color: me.roleColor } }, me.roleName)
      ),
      el('a', { class: 'icon-btn', href: '/auth/logout', title: 'Sign out' }, '⏻')
    )
  );

  const main = el(
    'div',
    { class: 'main' },
    el(
      'header',
      { class: 'topbar' },
      el('button', {
        class: 'menu-btn',
        id: 'menu-btn',
        title: 'Menu',
        onclick: () => document.querySelector('.app')?.classList.toggle('nav-open'),
      }, '≡'),
      el('h2', { id: 'page-title' }, 'Dashboard'),
      el('div', { class: 'spacer' }),
      el(
        'span',
        { class: 'live-dot', id: 'live-dot' },
        el('i'),
        el('span', { id: 'live-label' }, 'Connecting...')
      )
    ),
    el('div', { class: 'view', id: 'view' })
  );

  const backdrop = el('div', {
    class: 'nav-backdrop',
    onclick: () => app.classList.remove('nav-open'),
  });
  const app = el('div', { class: 'app' }, sidebar, backdrop, main);
  return app;
}

function refreshBadges() {
  for (const node of document.querySelectorAll('[data-badge]')) {
    const value = state.stats?.[node.dataset.badge] ?? 0;
    node.textContent = value;
    node.style.display = value > 0 ? '' : 'none';
  }
}

async function route() {
  const { name, arg } = parseHash();
  const def = ROUTES[name] || ROUTES[''];

  if (currentCleanup) {
    try { currentCleanup(); } catch { /* ignore */ }
    currentCleanup = null;
  }

  for (const a of document.querySelectorAll('.nav a')) {
    const target = a.dataset.route.replace(/^#\/?/, '');
    a.classList.toggle('active', target === name || (!target && !name));
  }

  document.getElementById('page-title').textContent = def.title;
  // A phone shows the nav as a drawer; picking a page should close it.
  document.querySelector('.app')?.classList.remove('nav-open');
  reportRoute();
  const view = document.getElementById('view');
  view.className = `view${def.flush ? ' flush' : ''}`;
  clear(view).append(el('div', { class: 'loading' }, 'Loading...'));

  try {
    const result = await def.render(view, arg);
    currentCleanup = typeof result === 'function' ? result : null;
  } catch (err) {
    console.error(err);
    clear(view).append(
      el(
        'div',
        { class: 'empty' },
        el('div', { class: 'big' }, '⚠'),
        el('div', {}, errMessage(err))
      )
    );
  }
}

boot();

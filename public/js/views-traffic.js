// ============================================================
// Website traffic - Gin only.
// Who is on the site right now, and everything about one person.
// ============================================================
import {
  el, clear, api, n, timeAgo, dateTime, clock, duration, roleBadge, errMessage,
} from './core.js';

const PAGE_NAMES = {
  '#/': 'Dashboard',
  '#/servers': 'Live Servers',
  '#/players': 'Player Database',
  '#/punishments': 'Punishments',
  '#/appeals': 'Appeals',
  '#/chat': 'Staff Chat',
  '#/staff': 'Staff Team',
  '#/keys': 'Game Connection',
  '#/access': 'Access & Security',
  '#/permissions': 'Rank Permissions',
  '#/traffic': 'Website Traffic',
};

function pageName(path) {
  if (!path) return 'Unknown';
  if (PAGE_NAMES[path]) return PAGE_NAMES[path];
  if (path.startsWith('#/player/')) return `Player ${path.slice(9)}`;
  if (path.startsWith('#/server/')) return `Server ${path.slice(9, 17)}…`;
  if (path.startsWith('#/visitor/')) return 'Visitor profile';
  return path;
}

// ---------------------------------------------------------------
// Live traffic
// ---------------------------------------------------------------
export async function trafficView(view) {
  let data = await api('/traffic');

  const render = () => {
    clear(view).append(
      el('div', { class: 'grid stats' },
        stat('On the site now', n(data.totals.onlineNow), 'panel open right now', 'good'),
        stat('Signed in', n(data.totals.signedIn), 'valid session, panel closed'),
        stat('Visitors today', n(data.totals.visitors24h), 'distinct people in 24h'),
        stat('Page views today', n(data.totals.views24h), 'across everyone')),
      el('div', { style: { height: '14px' } }),
      onlineCard(),
      el('div', { style: { height: '14px' } }),
      idleCard(),
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'grid two' }, topPagesCard(), recentCard())
    );
  };

  function onlineCard() {
    const body = el('div', { class: 'card-body tight' });
    if (!data.online.length) {
      body.append(el('div', { class: 'empty' },
        el('div', { class: 'big' }, '◌'),
        el('div', {}, 'Nobody has the panel open right now.')));
    } else {
      const t = el('table');
      t.append(el('thead', {}, el('tr', {},
        el('th', {}, 'Person'), el('th', {}, 'Rank'), el('th', {}, 'Looking at'),
        el('th', {}, 'On page for'), el('th', {}, 'Connected'), el('th', {}, 'Device'),
        el('th', {}, 'IP'), el('th', {}, ''))));
      const tb = el('tbody');
      for (const v of data.online) {
        tb.append(el('tr', { class: 'clickable', onclick: () => { location.hash = `#/visitor/${v.userId}`; } },
          el('td', {}, el('div', { class: 'user-cell' },
            el('img', { src: v.avatar, alt: '', style: { borderRadius: '50%' } }),
            el('div', { class: 'n' }, el('b', {}, v.username), el('span', {}, `@${v.handle}`)))),
          el('td', {}, roleBadge(v.role, v.roleName, v.roleColor)),
          el('td', {}, el('span', { class: 'pill info' }, pageName(v.route))),
          el('td', { class: 'muted nowrap' }, duration(Date.now() - v.routeAt)),
          el('td', { class: 'muted nowrap' }, duration(Date.now() - v.connectedAt)),
          el('td', { class: 'muted', style: { fontSize: '12px' } }, v.device),
          el('td', { class: 'mono muted', style: { fontSize: '11.5px' } }, v.ip || '—'),
          el('td', { class: 'right' },
            el('a', { class: 'btn sm', href: `#/visitor/${v.userId}` }, 'Inspect'))));
      }
      t.append(tb);
      body.append(t);
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, `On the site now — ${data.online.length}`),
        el('div', { class: 'spacer' }),
        el('span', { class: 'live-dot on' }, el('i'), 'refreshes every 5s')),
      body);
  }

  function idleCard() {
    const body = el('div', { class: 'card-body tight' });
    if (!data.idle.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'Nobody else holds a valid session.')));
    } else {
      const t = el('table');
      t.append(el('thead', {}, el('tr', {},
        el('th', {}, 'Person'), el('th', {}, 'Rank'), el('th', {}, 'Sessions'),
        el('th', {}, 'Last active'), el('th', {}, ''))));
      const tb = el('tbody');
      for (const v of data.idle) {
        tb.append(el('tr', { class: 'clickable', onclick: () => { location.hash = `#/visitor/${v.userId}`; } },
          el('td', {}, el('div', { class: 'user-cell' },
            el('img', { src: v.avatar, alt: '', style: { borderRadius: '50%' } }),
            el('div', { class: 'n' }, el('b', {}, v.username), el('span', {}, `@${v.handle}`)))),
          el('td', {}, roleBadge(v.role, v.roleName, v.roleColor)),
          el('td', { class: 'num muted' }, v.sessions),
          el('td', { class: 'muted nowrap' }, timeAgo(v.lastSeen)),
          el('td', { class: 'right' }, el('a', { class: 'btn sm', href: `#/visitor/${v.userId}` }, 'Inspect'))));
      }
      t.append(tb);
      body.append(t);
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, `Signed in, panel closed — ${data.idle.length}`)),
      body);
  }

  function topPagesCard() {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '320px', overflowY: 'auto' } });
    if (!data.topPages.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'No page views yet today.')));
    } else {
      const max = Math.max(...data.topPages.map((p) => p.views));
      const t = el('table');
      const tb = el('tbody');
      for (const p of data.topPages) {
        tb.append(el('tr', {},
          el('td', {}, el('div', {}, pageName(p.path)),
            el('div', { style: { height: '3px', marginTop: '4px', borderRadius: '2px', background: 'var(--accent)', width: `${Math.round((p.views / max) * 100)}%`, opacity: .55 } })),
          el('td', { class: 'num right' }, n(p.views)),
          el('td', { class: 'num muted right nowrap' }, `${p.people} · people`)));
      }
      t.append(tb);
      body.append(t);
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Most visited today')), body);
  }

  function recentCard() {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '320px', overflowY: 'auto' } });
    if (!data.recent.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'No traffic recorded yet.')));
    } else {
      const t = el('table');
      const tb = el('tbody');
      for (const r of data.recent) {
        tb.append(el('tr', {},
          el('td', {}, el('a', { href: `#/visitor/${r.userId}` }, r.username || '—')),
          el('td', { class: 'muted' }, pageName(r.path)),
          el('td', { class: 'muted nowrap right' }, timeAgo(r.at))));
      }
      t.append(tb);
      body.append(t);
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Recent page views')), body);
  }

  render();
  const timer = setInterval(async () => {
    try {
      data = await api('/traffic');
      render();
    } catch { /* keep the last render */ }
  }, 5000);
  return () => clearInterval(timer);
}

function stat(label, value, detail, kind) {
  return el('div', { class: `stat ${kind || ''}` },
    el('div', { class: 'k' }, label),
    el('div', { class: 'v' }, value),
    el('div', { class: 'd' }, detail));
}

// ---------------------------------------------------------------
// One visitor, in full
// ---------------------------------------------------------------
export async function visitorView(view, userId) {
  if (!userId) { location.hash = '#/traffic'; return; }

  let data;
  try {
    data = await api(`/traffic/${encodeURIComponent(userId)}`);
  } catch (err) {
    clear(view).append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, '⚠'),
      el('div', {}, errMessage(err)),
      el('div', { style: { marginTop: '14px' } }, el('a', { class: 'btn sm', href: '#/traffic' }, '← Traffic'))));
    return;
  }

  const u = data.user;

  clear(view).append(
    el('div', { class: 'toolbar' },
      el('a', { class: 'btn sm', href: '#/traffic' }, '← All traffic'),
      data.online ? el('span', { class: 'pill ok' }, `on ${pageName(data.online.route)} right now`) : el('span', { class: 'pill mute' }, 'not connected')),

    el('div', { class: 'card' },
      el('div', { class: 'card-body' },
        el('div', { class: 'profile-head' },
          el('img', { src: u.avatar, alt: '', style: { borderRadius: '50%' } }),
          el('div', { style: { flex: 1, minWidth: '220px' } },
            el('h2', {}, u.username),
            el('div', { class: 'sub' }, `@${u.handle} · `, el('span', { class: 'mono' }, u.discordId)),
            el('div', { class: 'chips' },
              roleBadge(u.role, u.roleName, u.roleColor),
              u.status === 'active' ? el('span', { class: 'pill ok' }, 'active') : el('span', { class: 'pill err' }, 'suspended'),
              u.whitelisted ? el('span', { class: 'pill info' }, 'whitelisted') : el('span', { class: 'pill warnp' }, 'not whitelisted'),
              u.robloxUsername ? el('span', { class: 'pill mute' }, `Roblox: ${u.robloxUsername}`) : null))))),

    el('div', { style: { height: '14px' } }),
    el('div', { class: 'grid stats' },
      stat('Page views', n(data.totals.views), 'all time'),
      stat('Staff actions', n(data.totals.actions), 'in the audit log'),
      stat('Chat messages', n(data.totals.messages), 'in staff chat'),
      stat('Punishments issued', n(data.totals.punishments), 'by this person'),
      stat('Active sessions', n(data.totals.activeSessions), 'signed-in devices'),
      stat('Account created', timeAgo(u.createdAt), dateTime(u.createdAt))),

    el('div', { style: { height: '14px' } }),
    data.online ? liveCard(data.online) : null,
    data.online ? el('div', { style: { height: '14px' } }) : null,

    el('div', { class: 'grid two' }, sessionsCard(), addressesCard()),
    el('div', { style: { height: '14px' } }),
    el('div', { class: 'grid two' }, pagesCard(), actionsCard()),
    data.rejectedLogins.length ? el('div', { style: { height: '14px' } }) : null,
    data.rejectedLogins.length ? rejectedCard() : null
  );

  function liveCard(live) {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, 'Right now'),
        el('div', { class: 'spacer' }),
        el('span', { class: 'live-dot on' }, el('i'), 'connected')),
      el('div', { class: 'card-body' },
        el('div', { class: 'kv' },
          kv('Current page', pageName(live.route)),
          kv('On this page for', duration(Date.now() - live.routeAt)),
          kv('Connected for', duration(Date.now() - live.connectedAt)),
          kv('IP address', live.ip || '—'),
          kv('Device', live.device),
          kv('Session', live.sessionId || '—'))));
  }

  function sessionsCard() {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '300px', overflowY: 'auto' } });
    const t = el('table');
    t.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Session'), el('th', {}, 'Device'), el('th', {}, 'IP'),
      el('th', {}, 'Started'), el('th', {}, 'Last used'))));
    const tb = el('tbody');
    for (const s of data.sessions) {
      tb.append(el('tr', {},
        el('td', {}, el('span', { class: 'mono', style: { fontSize: '11.5px' } }, s.id),
          s.active ? el('span', { class: 'pill ok', style: { marginLeft: '6px' } }, 'live') : null),
        el('td', { class: 'muted', style: { fontSize: '12px' } }, s.device),
        el('td', { class: 'mono muted', style: { fontSize: '11.5px' } }, s.ip || '—'),
        el('td', { class: 'muted nowrap' }, timeAgo(s.createdAt)),
        el('td', { class: 'muted nowrap' }, timeAgo(s.lastUsed || s.createdAt))));
    }
    t.append(tb);
    body.append(data.sessions.length ? t : el('div', { class: 'empty' }, el('div', {}, 'No sessions recorded.')));
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, `Sign-ins — ${data.sessions.length}`)), body);
  }

  function addressesCard() {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '300px', overflowY: 'auto' } });
    if (!data.addresses.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'No addresses recorded.')));
    } else {
      const t = el('table');
      t.append(el('thead', {}, el('tr', {},
        el('th', {}, 'IP address'), el('th', {}, 'Views'), el('th', {}, 'First seen'), el('th', {}, 'Last seen'))));
      const tb = el('tbody');
      for (const a of data.addresses) {
        tb.append(el('tr', {},
          el('td', { class: 'mono' }, a.ip),
          el('td', { class: 'num muted' }, n(a.hits)),
          el('td', { class: 'muted nowrap' }, timeAgo(a.firstAt)),
          el('td', { class: 'muted nowrap' }, timeAgo(a.lastAt))));
      }
      t.append(tb);
      body.append(t);
      body.append(el('div', { class: 'card-body' },
        el('div', { class: 'k', style: { fontSize: '10.5px', color: 'var(--text-faint)', fontWeight: 600, marginBottom: '6px' } }, 'DEVICES'),
        ...data.devices.map((d) =>
          el('div', { style: { fontSize: '12.5px', padding: '3px 0' } },
            d.device,
            el('span', { class: 'muted' }, ` · ${n(d.hits)} views · ${timeAgo(d.lastAt)}`)))));
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Addresses and devices')), body);
  }

  function pagesCard() {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '340px', overflowY: 'auto' } });
    if (!data.pageViews.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'No page views recorded.')));
    } else {
      const t = el('table');
      const tb = el('tbody');
      for (const v of data.pageViews) {
        tb.append(el('tr', {},
          el('td', {}, pageName(v.path)),
          el('td', { class: 'mono muted', style: { fontSize: '11px' } }, v.path),
          el('td', { class: 'muted nowrap right' }, dateTime(v.at))));
      }
      t.append(tb);
      body.append(t);
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, 'Every page they opened'),
        el('div', { class: 'spacer' }),
        el('span', { class: 'muted', style: { fontSize: '12px' } }, 'newest first')),
      body);
  }

  function actionsCard() {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '340px', overflowY: 'auto' } });
    if (!data.actions.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'No recorded actions.')));
    } else {
      const t = el('table');
      const tb = el('tbody');
      for (const a of data.actions) {
        tb.append(el('tr', {},
          el('td', { class: 'mono', style: { fontSize: '11.5px' } }, a.action),
          el('td', { class: 'muted', style: { fontSize: '12px' } }, a.target || '—'),
          el('td', { class: 'muted', style: { fontSize: '12px', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis' } }, a.detail || ''),
          el('td', { class: 'muted nowrap right' }, timeAgo(a.at))));
      }
      t.append(tb);
      body.append(t);
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Everything they did')), body);
  }

  function rejectedCard() {
    const body = el('div', { class: 'card-body tight' });
    const t = el('table');
    const tb = el('tbody');
    for (const r of data.rejectedLogins) {
      tb.append(el('tr', {},
        el('td', {}, el('span', { class: 'pill warnp' }, r.reason)),
        el('td', { class: 'mono muted' }, r.ip || '—'),
        el('td', { class: 'muted nowrap right' }, dateTime(r.at))));
    }
    t.append(tb);
    body.append(t);
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Blocked sign-in attempts')), body);
  }

  function kv(k, v) {
    return el('div', {}, el('div', { class: 'k' }, k), el('div', { class: 'v', style: { fontSize: '14px' } }, v));
  }
}

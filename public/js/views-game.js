// ============================================================
// Dashboard - live stats for the game
// ============================================================
import {
  state, el, clear, api, n, timeAgo, clock, lineChart, on, roleBadge, playtime,
} from './core.js';

const STAT_CARDS = [
  { key: 'players', label: 'Players in game', kind: 'good', detail: (s) => `${n(s.servers)} live server${s.servers === 1 ? '' : 's'}` },
  { key: 'servers', label: 'Active servers', detail: (s) => (s.capacity ? `${s.fill}% of ${n(s.capacity)} slots` : 'no capacity reported') },
  { key: 'peak24', label: 'Peak today', detail: () => 'highest concurrent players' },
  { key: 'joins1h', label: 'Joins / hour', detail: (s) => `${n(s.joins24)} in the last 24h` },
  { key: 'uniques24', label: 'Unique players 24h', detail: (s) => `${n(s.newPlayers24)} brand new` },
  { key: 'activeBans', label: 'Active bans', kind: 'bad', detail: (s) => `${n(s.bans24)} issued today` },
  { key: 'modActions24', label: 'Mod actions 24h', kind: 'warn', detail: () => 'warns, mutes, kicks, bans' },
  { key: 'knownPlayers', label: 'Players on record', detail: (s) => `${n(s.pendingAppeals)} appeals waiting` },
];

export async function dashboardView(view) {
  const [live, hist, feed, servers] = await Promise.all([
    api('/stats/live'),
    api('/stats/history?minutes=180'),
    api('/feed?limit=25'),
    api('/servers'),
  ]);

  state.stats = live.stats;
  state.staffOnline = live.staffOnline;

  const statGrid = el('div', { class: 'grid stats' });
  const chartSlot = el('div', { class: 'card-body tight' });
  const healthSlot = el('div', { class: 'card-body' });
  const feedSlot = el('div', { class: 'card-body tight', style: { maxHeight: '420px', overflowY: 'auto' } });
  const onlineSlot = el('div', { class: 'card-body' });
  const serverSlot = el('div', { class: 'card-body tight' });

  const renderStats = (s) => {
    clear(statGrid);
    for (const card of STAT_CARDS) {
      statGrid.append(
        el(
          'div',
          { class: `stat ${card.kind || ''}` },
          el('div', { class: 'k' }, card.label),
          el('div', { class: 'v' }, n(s[card.key])),
          el('div', { class: 'd' }, card.detail(s))
        )
      );
    }
  };

  const renderHealth = (s) => {
    clear(healthSlot).append(
      el(
        'div',
        { class: 'kv' },
        kv('Average FPS', s.avgFps == null ? '-' : s.avgFps.toFixed(1)),
        kv('Average ping', s.avgPing == null ? '-' : `${s.avgPing} ms`),
        kv('Server fill', `${s.fill}%`),
        kv('Queued actions', n(s.queuedActions)),
        kv('Pending appeals', n(s.pendingAppeals)),
        kv('Updated', clock(s.at))
      )
    );
  };

  const renderChart = (points) => {
    clear(chartSlot).append(
      lineChart(points.map((p) => ({ t: p.t, v: p.players })), { color: '#ffa32e' }),
      el(
        'div',
        { class: 'chart-legend' },
        el('span', {}, el('i', { style: { background: '#ffa32e' } }), 'Concurrent players, last 3 hours')
      )
    );
  };

  const renderOnline = () => {
    clear(onlineSlot);
    if (!state.staffOnline.length) {
      onlineSlot.append(el('div', { class: 'muted', style: { fontSize: '13px' } }, 'Nobody else is in the panel right now.'));
      return;
    }
    for (const s of state.staffOnline) {
      onlineSlot.append(
        el(
          'div',
          { class: 'online-row' },
          el('img', { src: s.avatar, alt: '' }),
          el('div', { style: { minWidth: 0, flex: '1' } }, el('div', { class: 'n' }, s.username)),
          roleBadge(s.role, s.roleName, s.roleColor)
        )
      );
    }
  };

  const renderFeed = (events) => {
    clear(feedSlot);
    if (!events.length) {
      feedSlot.append(
        el('div', { class: 'empty' }, el('div', { class: 'big' }, '◌'),
          el('div', {}, 'No game events yet.'),
          el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
            'Once a server sends its first heartbeat, joins, leaves and moderation land here.'))
      );
      return;
    }
    const list = el('ul', { class: 'timeline', style: { padding: '4px 16px 12px' } });
    for (const e of events) {
      list.append(
        el(
          'li',
          { class: e.type === 'moderation' ? 'ban' : '' },
          el(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
            el('span', { class: `pill ${feedPill(e.type)}` }, e.type),
            e.username
              ? el('a', { href: `#/player/${e.robloxId}`, style: { fontWeight: 600 } }, e.username)
              : el('span', { class: 'muted' }, '-'),
            el('span', { class: 'when' }, timeAgo(e.at))
          ),
          e.detail ? el('div', { class: 'muted', style: { fontSize: '12.5px' } }, e.detail) : null
        )
      );
    }
    feedSlot.append(list);
  };

  const renderServers = (list) => {
    clear(serverSlot);
    if (!list.length) {
      serverSlot.append(
        el('div', { class: 'empty' },
          el('div', { class: 'big' }, '☷'),
          el('div', {}, 'No servers are reporting in.'),
          el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
            'Install the ZahHoodCentral script in your game and point it at this site.'))
      );
      return;
    }
    const table = el('table');
    table.append(
      el('thead', {}, el('tr', {},
        el('th', {}, 'Server ID'), el('th', {}, 'Players'),
        el('th', {}, 'Uptime'), el('th', {}, 'FPS'), el('th', {}, 'Last beat')))
    );
    const tbody = el('tbody');
    for (const s of list.slice(0, 8)) {
      tbody.append(
        el('tr', { class: 'clickable', onclick: () => { location.hash = `#/server/${s.id}`; } },
          el('td', { class: 'mono' }, s.id.slice(0, 18) + (s.id.length > 18 ? '…' : '')),
          el('td', { class: 'num' }, `${s.players}/${s.maxPlayers || '?'}`),
          el('td', { class: 'num muted' }, playtime(s.uptime)),
          el('td', { class: 'num muted' }, s.fps == null ? '-' : s.fps.toFixed(0)),
          el('td', { class: 'muted nowrap' }, timeAgo(s.lastBeat)))
      );
    }
    table.append(tbody);
    serverSlot.append(table);
  };

  renderStats(live.stats);
  renderHealth(live.stats);
  renderChart(hist.history);
  renderOnline();
  renderFeed(feed.events);
  renderServers(servers.servers);

  clear(view).append(
    statGrid,
    el('div', { style: { height: '14px' } }),
    el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Concurrent players'), el('div', { class: 'spacer' }),
        el('span', { class: 'muted', style: { fontSize: '12px' } }, 'updates every 10s')),
      chartSlot),
    el('div', { style: { height: '14px' } }),
    el('div', { class: 'grid two' },
      el('div', { class: 'card' },
        el('div', { class: 'card-head' }, el('h3', {}, 'Game health')), healthSlot),
      el('div', { class: 'card' },
        el('div', { class: 'card-head' }, el('h3', {}, 'Staff in the panel')), onlineSlot)),
    el('div', { style: { height: '14px' } }),
    el('div', { class: 'grid two' },
      el('div', { class: 'card' },
        el('div', { class: 'card-head' }, el('h3', {}, 'Live servers'), el('div', { class: 'spacer' }),
          el('a', { href: '#/servers', style: { fontSize: '12px' } }, 'View all')),
        serverSlot),
      el('div', { class: 'card' },
        el('div', { class: 'card-head' }, el('h3', {}, 'Activity feed')), feedSlot))
  );

  // Live updates over the websocket, plus a slow poll for the graph.
  const offStats = on('stats', (m) => {
    renderStats(m.stats);
    renderHealth(m.stats);
  });
  const offPresence = on('presence', renderOnline);
  const offJoin = on('player_join', async () => {
    try {
      const f = await api('/feed?limit=25');
      renderFeed(f.events);
    } catch { /* ignore */ }
  });

  const timer = setInterval(async () => {
    try {
      const [h, s] = await Promise.all([api('/stats/history?minutes=180'), api('/servers')]);
      renderChart(h.history);
      renderServers(s.servers);
    } catch { /* ignore */ }
  }, 30_000);

  return () => {
    offStats(); offPresence(); offJoin();
    clearInterval(timer);
  };
}

function kv(k, v) {
  return el('div', {}, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
}

function feedPill(type) {
  return { join: 'ok', leave: 'mute', moderation: 'err', chat: 'info', report: 'warnp' }[type] || 'mute';
}

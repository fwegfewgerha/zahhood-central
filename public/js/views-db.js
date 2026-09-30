// ============================================================
// Player database, punishments, live servers + server lookup
// ============================================================
import {
  el, clear, api, toast, errMessage, can, modal, confirmDialog,
  n, timeAgo, dateTime, playtime, punishPill, roleBadge, state, on,
} from './core.js';

// ---------------------------------------------------------------
// Player database
// ---------------------------------------------------------------
export async function playersView(view) {
  let query = '';
  let filter = '';
  let offset = 0;
  const LIMIT = 40;

  const search = el('input', {
    type: 'search',
    placeholder: 'Username or Roblox user ID…',
    oninput: debounce((e) => { query = e.target.value.trim(); offset = 0; load(); }, 280),
  });
  const filterSel = el('select', { onchange: (e) => { filter = e.target.value; offset = 0; load(); } },
    el('option', { value: '' }, 'Everyone'),
    el('option', { value: 'online' }, 'In game right now'),
    el('option', { value: 'banned' }, 'Currently banned'),
    el('option', { value: 'flagged' }, 'Flagged accounts'),
    el('option', { value: 'new' }, 'New this week'));

  const count = el('span', { class: 'muted', style: { fontSize: '12.5px' } });
  const body = el('div', { class: 'card-body tight' });
  const pager = el('div', { style: { display: 'flex', gap: '8px', padding: '12px 16px', alignItems: 'center' } });

  clear(view).append(
    el('div', { class: 'toolbar' }, search, filterSel, count,
      can('punish.ban.temp')
        ? el('button', { class: 'btn primary', style: { marginLeft: 'auto' }, onclick: () => offlinePunishDialog() }, '⛔ Punish by ID')
        : null),
    el('div', { class: 'card' }, body, pager)
  );

  async function load() {
    clear(body).append(el('div', { class: 'loading' }, 'Searching…'));
    const params = new URLSearchParams({ limit: LIMIT, offset });
    if (query) params.set('q', query);
    if (filter) params.set('filter', filter);

    const data = await api(`/players?${params}`);
    count.textContent = `${n(data.total)} player${data.total === 1 ? '' : 's'}`;

    clear(body);
    if (!data.players.length) {
      body.append(el('div', { class: 'empty' },
        el('div', { class: 'big' }, '▦'),
        el('div', {}, query ? 'Nobody matches that search.' : 'The database is empty.'),
        el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          'Players are added automatically the first time they join a server.')));
      clear(pager);
      return;
    }

    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Player'), el('th', {}, 'Status'), el('th', {}, 'Level'),
      el('th', {}, 'Playtime'), el('th', {}, 'Joins'), el('th', {}, 'Record'),
      el('th', {}, 'Last seen'))));

    const tbody = el('tbody');
    for (const p of data.players) {
      tbody.append(el('tr', { class: 'clickable', onclick: () => { location.hash = `#/player/${p.robloxId}`; } },
        el('td', {}, el('div', { class: 'user-cell' },
          el('img', { src: p.avatar, alt: '', loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }),
          el('div', { class: 'n' },
            el('b', {}, p.username),
            el('span', { class: 'mono' }, p.robloxId)))),
        el('td', {}, p.banned
          ? el('span', { class: 'pill err' }, 'banned')
          : p.onlineServer
            ? el('span', { class: 'pill ok' }, 'in game')
            : el('span', { class: 'pill mute' }, 'offline')),
        el('td', { class: 'num' }, p.level),
        el('td', { class: 'num muted' }, playtime(p.playtime)),
        el('td', { class: 'num muted' }, n(p.joins)),
        el('td', { class: 'num' }, p.punishments
          ? el('span', { class: 'pill warnp' }, p.punishments)
          : el('span', { class: 'muted' }, '—')),
        el('td', { class: 'muted nowrap' }, timeAgo(p.lastSeen))));
    }
    table.append(tbody);
    body.append(table);

    clear(pager).append(
      el('button', { class: 'btn sm', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - LIMIT); load(); } }, '← Previous'),
      el('button', { class: 'btn sm', disabled: offset + LIMIT >= data.total, onclick: () => { offset += LIMIT; load(); } }, 'Next →'),
      el('span', { class: 'muted', style: { fontSize: '12px' } },
        `${offset + 1}–${Math.min(offset + LIMIT, data.total)} of ${n(data.total)}`)
    );
  }

  await load();
}

// ---------------------------------------------------------------
// Player profile
// ---------------------------------------------------------------
export async function playerView(view, robloxId) {
  if (!robloxId) { location.hash = '#/players'; return; }
  const data = await api(`/players/${encodeURIComponent(robloxId)}`);
  const p = data.player;

  const render = () => {
    clear(view).append(
      el('div', { class: 'card' },
        el('div', { class: 'card-body' },
          el('div', { class: 'profile-head' },
            el('img', { src: p.avatar, alt: '' }),
            el('div', { style: { flex: '1', minWidth: '220px' } },
              el('h2', {}, p.username),
              el('div', { class: 'sub' },
                p.displayName && p.displayName !== p.username ? `${p.displayName} · ` : '',
                el('span', { class: 'mono' }, p.robloxId), ' · ',
                el('a', { href: p.profileUrl, target: '_blank', rel: 'noopener' }, 'Roblox profile')),
              el('div', { class: 'chips' },
                data.activeBan
                  ? el('span', { class: 'pill err' }, data.activeBan.permanent ? 'Permanently banned' : `Banned · ${timeAgo(data.activeBan.expiresAt)}`.replace(' ago', ' left'))
                  : el('span', { class: 'pill ok' }, 'In good standing'),
                data.online ? el('span', { class: 'pill info' }, 'In game now') : null,
                ...(p.flags || []).map((f) => el('span', { class: 'pill warnp' }, f)),
                p.crew ? el('span', { class: 'pill mute' }, `Crew: ${p.crew}`) : null)),
            el('div', { class: 'btn-row', style: { alignItems: 'flex-start' } }, ...actionButtons())))),
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'grid stats' },
        stat('Level', n(p.level)), stat('Cash', n(p.cash)),
        stat('Playtime', playtime(p.playtime)), stat('Joins', n(p.joins)),
        stat('K / D', `${n(p.kills)} / ${n(p.deaths)}`),
        stat('Account age', p.accountAgeDays ? `${n(p.accountAgeDays)}d` : '—'),
        stat('First seen', timeAgo(p.firstSeen)), stat('Last seen', timeAgo(p.lastSeen))),
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'grid two' }, punishmentCard(), notesCard()),
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'grid two' }, historyCard(), altsCard())
    );
  };

  function actionButtons() {
    const out = [];
    const add = (perm, label, kind, type) => {
      if (can(perm)) out.push(el('button', { class: `btn ${kind}`, onclick: () => punishDialog(p, type, reload) }, label));
    };
    add('punish.warn', 'Warn', 'sm', 'warn');
    add('punish.mute', 'Mute', 'sm', 'mute');
    add('punish.kick', 'Kick', 'sm', 'kick');
    if (can('punish.ban.temp') || can('punish.ban.perm')) {
      out.push(el('button', { class: 'btn danger', onclick: () => punishDialog(p, 'ban', reload) }, '⛔ Ban'));
    }
    return out;
  }

  function punishmentCard() {
    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Punishment record'),
        el('div', { class: 'spacer' }),
        el('span', { class: 'muted', style: { fontSize: '12px' } }, `${data.punishments.length} total`)));

    if (!data.punishments.length) {
      card.append(el('div', { class: 'empty' }, el('div', {}, 'Clean record.')));
      return card;
    }
    const list = el('ul', { class: 'timeline', style: { padding: '12px 16px' } });
    for (const pun of data.punishments) {
      list.append(el('li', { class: pun.type },
        el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          punishPill(pun),
          el('b', { style: { fontSize: '13px' } }, pun.reason),
          can('punish.revoke') && pun.active
            ? el('button', { class: 'btn sm', style: { marginLeft: 'auto' }, onclick: () => revoke(pun) }, 'Lift')
            : null),
        el('div', { class: 'when' },
          `by ${pun.issuedBy || 'system'}`,
          pun.issuedByRoleName ? ` (${pun.issuedByRoleName})` : '',
          ` · ${dateTime(pun.issuedAt)}`,
          pun.expiresAt ? ` · expires ${dateTime(pun.expiresAt)}` : pun.type === 'ban' ? ' · permanent' : ''),
        pun.revokedBy ? el('div', { class: 'when' }, `lifted by ${pun.revokedBy}${pun.revokeReason ? ` — ${pun.revokeReason}` : ''}`) : null,
        pun.evidence ? el('div', { class: 'muted', style: { fontSize: '12px' } }, `Evidence: ${pun.evidence}`) : null));
    }
    card.append(list);
    return card;
  }

  function notesCard() {
    const list = el('div', { class: 'card-body tight', style: { maxHeight: '300px', overflowY: 'auto' } });
    if (!data.notes.length) {
      list.append(el('div', { class: 'empty' }, el('div', {}, 'No staff notes yet.')));
    } else {
      const ul = el('ul', { class: 'timeline', style: { padding: '12px 16px' } });
      for (const note of data.notes) {
        ul.append(el('li', {},
          el('div', { style: { fontSize: '13px' } }, note.body),
          el('div', { class: 'when' }, note.author, ' · ', roleBadge(note.authorRole, note.authorRoleName, note.authorRoleColor), ' · ', timeAgo(note.at))));
      }
      list.append(ul);
    }

    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Staff notes')), list);

    if (can('db.note')) {
      const input = el('textarea', { placeholder: 'Leave a note for the rest of the team…', rows: 2 });
      card.append(el('div', { class: 'card-body', style: { borderTop: '1px solid var(--line-soft)' } },
        input,
        el('div', { style: { height: '8px' } }),
        el('button', {
          class: 'btn primary sm',
          onclick: async (e) => {
            const body = input.value.trim();
            if (!body) return;
            e.target.disabled = true;
            try {
              await api(`/players/${p.robloxId}/notes`, { method: 'POST', body: { body } });
              toast('Note saved.', 'ok');
              reload();
            } catch (err) {
              toast(errMessage(err), 'err');
              e.target.disabled = false;
            }
          },
        }, 'Add note')));
    }
    return card;
  }

  function historyCard() {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '300px', overflowY: 'auto' } });
    if (!data.events.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'No recorded activity.')));
    } else {
      const table = el('table');
      const tbody = el('tbody');
      for (const e of data.events) {
        tbody.append(el('tr', {},
          el('td', { style: { width: '90px' } }, el('span', { class: 'pill mute' }, e.type)),
          el('td', { class: 'muted' }, e.detail || '—'),
          el('td', { class: 'muted nowrap right' }, timeAgo(e.at))));
      }
      table.append(tbody);
      body.append(table);
    }
    return el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Recent activity')), body);
  }

  function altsCard() {
    const body = el('div', { class: 'card-body' });
    if (data.knownNames.length > 1) {
      body.append(el('div', { class: 'k', style: { fontSize: '10.5px', color: 'var(--text-faint)', fontWeight: 600, marginBottom: '6px' } }, 'KNOWN USERNAMES'),
        el('div', { class: 'chips', style: { marginBottom: '16px' } },
          ...data.knownNames.map((name) => el('span', { class: 'pill mute' }, name))));
    }
    body.append(el('div', { class: 'k', style: { fontSize: '10.5px', color: 'var(--text-faint)', fontWeight: 600, marginBottom: '6px' } }, 'POSSIBLE ALT ACCOUNTS'));
    if (!data.possibleAlts.length) {
      body.append(el('div', { class: 'muted', style: { fontSize: '13px' } }, 'None detected.'));
    } else {
      for (const alt of data.possibleAlts) {
        body.append(el('div', { style: { padding: '5px 0' } },
          el('a', { href: `#/player/${alt.robloxId}` }, alt.username),
          el('span', { class: 'muted', style: { fontSize: '12px' } }, ` · ${timeAgo(alt.lastSeen)}`)));
      }
      body.append(el('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '8px' } },
        'Matched on the last connection fingerprint. Treat as a lead, not proof.'));
    }
    return el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Identity')), body);
  }

  async function revoke(pun) {
    const ok = await confirmDialog('Lift punishment', `Lift the ${pun.type} on ${p.username}? They will be let back in on their next join.`, 'Lift it');
    if (!ok) return;
    try {
      await api(`/punishments/${pun.id}/revoke`, { method: 'POST', body: { reason: 'Lifted from player profile' } });
      toast('Punishment lifted.', 'ok');
      reload();
    } catch (err) {
      toast(errMessage(err), 'err');
    }
  }

  function reload() { playerView(view, robloxId); }

  render();
}

function stat(label, value) {
  return el('div', { class: 'stat' }, el('div', { class: 'k' }, label), el('div', { class: 'v' }, value));
}

// ---------------------------------------------------------------
// Punish dialog (shared)
// ---------------------------------------------------------------
export function punishDialog(player, type, onDone) {
  const isBan = type === 'ban';
  const reason = el('textarea', { placeholder: 'Why? This is shown to the player.', rows: 3 });
  const evidence = el('input', { type: 'text', placeholder: 'Link to a clip or screenshot (optional)' });

  const durations = isBan || type === 'mute'
    ? [
        ['1h', '1 hour'], ['6h', '6 hours'], ['1d', '1 day'], ['3d', '3 days'],
        ['7d', '1 week'], ['30d', '30 days'], ['perm', 'Permanent'],
      ]
    : null;

  const duration = durations
    ? el('select', {}, ...durations
        .filter(([v]) => v !== 'perm' || !isBan || can('punish.ban.perm'))
        .map(([v, label]) => el('option', { value: v }, label)))
    : null;
  if (duration) duration.value = isBan ? '7d' : '1h';

  modal({
    title: `${type[0].toUpperCase() + type.slice(1)} ${player.username}`,
    body: el('div', {},
      el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' } },
        el('img', { src: player.avatar, alt: '', style: { width: '44px', height: '44px', borderRadius: '10px' } }),
        el('div', {},
          el('b', {}, player.username),
          el('div', { class: 'mono muted' }, player.robloxId))),
      el('label', { class: 'field' }, el('span', {}, 'Reason'), reason),
      duration ? el('label', { class: 'field' }, el('span', {}, 'Duration'), duration) : null,
      el('label', { class: 'field' }, el('span', {}, 'Evidence'), evidence),
      isBan
        ? el('div', { class: 'muted', style: { fontSize: '12px' } },
            'The ban reaches live servers on the next heartbeat, and blocks the player at their next join attempt.')
        : null),
    actions: [
      { label: 'Cancel' },
      {
        kind: isBan ? 'danger' : 'primary',
        label: `Issue ${type}`,
        onClick: async () => {
          const body = reason.value.trim();
          if (!body) { toast('A reason is required.', 'err'); return 'keep'; }
          await api(`/players/${player.robloxId}/punish`, {
            method: 'POST',
            body: {
              type,
              reason: body,
              username: player.username,
              duration: duration ? duration.value : undefined,
              evidence: evidence.value.trim() || undefined,
            },
          });
          toast(`${player.username} was ${type === 'ban' ? 'banned' : type + 'ed'}.`, 'ok');
          onDone?.();
        },
      },
    ],
    onOpen: () => reason.focus(),
  });
}

/** Ban someone who is not in the database yet, straight from their user ID. */
function offlinePunishDialog() {
  const idInput = el('input', { type: 'text', placeholder: 'Roblox user ID, e.g. 1234567' });
  const nameInput = el('input', { type: 'text', placeholder: 'Username (optional, for the record)' });
  modal({
    title: 'Punish by Roblox ID',
    body: el('div', {},
      el('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '14px' } },
        'Use this for players who have never joined, or who are offline. The punishment applies the moment they next try to join.'),
      el('label', { class: 'field' }, el('span', {}, 'Roblox user ID'), idInput),
      el('label', { class: 'field' }, el('span', {}, 'Username'), nameInput)),
    actions: [
      { label: 'Cancel' },
      {
        kind: 'primary',
        label: 'Continue',
        onClick: () => {
          const id = parseInt(idInput.value.trim(), 10);
          if (!Number.isFinite(id) || id <= 0) { toast('Enter a numeric Roblox user ID.', 'err'); return 'keep'; }
          const username = nameInput.value.trim() || `user_${id}`;
          setTimeout(() => punishDialog(
            { robloxId: id, username, avatar: `https://www.roblox.com/headshot-thumbnail/image?userId=${id}&width=150&height=150&format=png` },
            'ban',
            () => { location.hash = `#/player/${id}`; }
          ), 60);
        },
      },
    ],
    onOpen: () => idInput.focus(),
  });
}

// ---------------------------------------------------------------
// Punishments list
// ---------------------------------------------------------------
export async function punishmentsView(view) {
  let type = '';
  let q = '';
  let activeOnly = true;

  const body = el('div', { class: 'card-body tight' });
  const search = el('input', {
    type: 'search', placeholder: 'Player, ID or reason…',
    oninput: debounce((e) => { q = e.target.value.trim(); load(); }, 280),
  });
  const typeSel = el('select', { onchange: (e) => { type = e.target.value; load(); } },
    el('option', { value: '' }, 'All types'),
    el('option', { value: 'ban' }, 'Bans'),
    el('option', { value: 'kick' }, 'Kicks'),
    el('option', { value: 'mute' }, 'Mutes'),
    el('option', { value: 'warn' }, 'Warnings'));
  const activeBox = el('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', whiteSpace: 'nowrap' } },
    el('input', { type: 'checkbox', checked: true, style: { width: 'auto' }, onchange: (e) => { activeOnly = e.target.checked; load(); } }),
    'Active only');

  const scopeNote = can('punish.viewAll')
    ? null
    : el('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '12px' } },
        'Your role only shows punishments you issued yourself.');

  clear(view).append(
    el('div', { class: 'toolbar' }, search, typeSel, activeBox),
    scopeNote,
    el('div', { class: 'card' }, body)
  );

  async function load() {
    clear(body).append(el('div', { class: 'loading' }, 'Loading…'));
    const params = new URLSearchParams({ limit: 100 });
    if (type) params.set('type', type);
    if (q) params.set('q', q);
    if (activeOnly) params.set('active', '1');

    const data = await api(`/punishments?${params}`);
    clear(body);

    if (!data.punishments.length) {
      body.append(el('div', { class: 'empty' },
        el('div', { class: 'big' }, '✔'),
        el('div', {}, 'Nothing matches.')));
      return;
    }

    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Player'), el('th', {}, 'Type'), el('th', {}, 'Reason'),
      el('th', {}, 'Issued by'), el('th', {}, 'When'), el('th', {}, 'Expires'), el('th', {}, ''))));

    const tbody = el('tbody');
    for (const p of data.punishments) {
      tbody.append(el('tr', {},
        el('td', {}, el('a', { href: `#/player/${p.robloxId}` }, p.username),
          el('div', { class: 'mono muted' }, p.robloxId)),
        el('td', {}, punishPill(p)),
        el('td', { style: { maxWidth: '280px' } }, p.reason),
        el('td', {}, el('div', {}, p.issuedBy || 'system'),
          p.issuedByRoleName ? el('div', {}, roleBadge(p.issuedByRole, p.issuedByRoleName, p.issuedByRoleColor)) : null),
        el('td', { class: 'muted nowrap' }, timeAgo(p.issuedAt)),
        el('td', { class: 'muted nowrap' }, p.expiresAt ? dateTime(p.expiresAt) : p.type === 'ban' ? 'never' : '—'),
        el('td', { class: 'right' },
          can('punish.revoke') && p.active
            ? el('button', {
                class: 'btn sm',
                onclick: async () => {
                  const ok = await confirmDialog('Lift punishment', `Lift the ${p.type} on ${p.username}?`, 'Lift it');
                  if (!ok) return;
                  try {
                    await api(`/punishments/${p.id}/revoke`, { method: 'POST', body: { reason: 'Lifted from punishment list' } });
                    toast('Lifted.', 'ok');
                    load();
                  } catch (err) { toast(errMessage(err), 'err'); }
                },
              }, 'Lift')
            : null)));
    }
    table.append(tbody);
    body.append(table);
  }

  await load();
}

// ---------------------------------------------------------------
// Live servers
// ---------------------------------------------------------------
export async function serversView(view) {
  const lookup = el('input', {
    type: 'text',
    placeholder: 'Paste a server ID (JobId) to inspect…',
    style: { maxWidth: '380px' },
    onkeydown: (e) => { if (e.key === 'Enter') go(); },
  });
  const body = el('div', { class: 'card-body tight' });
  let showOffline = false;

  function go() {
    const id = lookup.value.trim();
    if (id) location.hash = `#/server/${encodeURIComponent(id)}`;
  }

  clear(view).append(
    el('div', { class: 'toolbar' },
      lookup,
      el('button', { class: 'btn primary', onclick: go }, 'Look up server'),
      el('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', marginLeft: 'auto' } },
        el('input', { type: 'checkbox', style: { width: 'auto' }, onchange: (e) => { showOffline = e.target.checked; load(); } }),
        'Include offline')),
    el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Servers'), el('div', { class: 'spacer' }),
        el('span', { class: 'muted', style: { fontSize: '12px' } }, 'a server disappears ~90s after its last heartbeat')),
      body)
  );

  async function load() {
    const data = await api(`/servers${showOffline ? '?all=1' : ''}`);
    clear(body);
    if (!data.servers.length) {
      body.append(el('div', { class: 'empty' },
        el('div', { class: 'big' }, '☷'),
        el('div', {}, 'No servers are reporting in right now.'),
        el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          'Check the Game Connection page for the script and key your game needs.')));
      return;
    }
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Server ID'), el('th', {}, 'Status'), el('th', {}, 'Players'),
      el('th', {}, 'Region'), el('th', {}, 'Uptime'), el('th', {}, 'FPS'),
      el('th', {}, 'Ping'), el('th', {}, 'Last beat'))));
    const tbody = el('tbody');
    for (const s of data.servers) {
      tbody.append(el('tr', { class: 'clickable', onclick: () => { location.hash = `#/server/${encodeURIComponent(s.id)}`; } },
        el('td', { class: 'mono' }, s.id),
        el('td', {}, s.status === 'online'
          ? el('span', { class: 'pill ok' }, 'online')
          : el('span', { class: 'pill mute' }, 'offline')),
        el('td', { class: 'num' }, `${s.players}/${s.maxPlayers || '?'}`),
        el('td', { class: 'muted' }, s.region || '—'),
        el('td', { class: 'num muted' }, playtime(s.uptime)),
        el('td', { class: 'num muted' }, s.fps == null ? '—' : s.fps.toFixed(0)),
        el('td', { class: 'num muted' }, s.ping == null ? '—' : `${Math.round(s.ping)}ms`),
        el('td', { class: 'muted nowrap' }, timeAgo(s.lastBeat))));
    }
    table.append(tbody);
    body.append(table);
  }

  await load();
  const timer = setInterval(() => load().catch(() => {}), 15_000);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------
// Single server - who is inside it
// ---------------------------------------------------------------
export async function serverView(view, serverId) {
  if (!serverId) { location.hash = '#/servers'; return; }

  async function load() {
    let data;
    try {
      data = await api(`/servers/${encodeURIComponent(serverId)}`);
    } catch (err) {
      clear(view).append(el('div', { class: 'empty' },
        el('div', { class: 'big' }, '☷'),
        el('div', {}, errMessage(err)),
        el('div', { class: 'mono muted', style: { marginTop: '8px' } }, serverId),
        el('div', { style: { marginTop: '14px' } },
          el('a', { class: 'btn sm', href: '#/servers' }, '← All servers'))));
      return;
    }

    const s = data.server;
    const roster = el('div', { class: 'card-body tight' });

    if (!data.players.length) {
      roster.append(el('div', { class: 'empty' }, el('div', {}, 'Nobody is in this server.')));
    } else {
      const table = el('table');
      table.append(el('thead', {}, el('tr', {},
        el('th', {}, 'Player'), el('th', {}, 'Team'), el('th', {}, 'In server for'),
        el('th', {}, 'Level'), el('th', {}, 'Account age'), el('th', {}, 'Record'), el('th', {}, ''))));
      const tbody = el('tbody');
      for (const pl of data.players) {
        tbody.append(el('tr', {},
          el('td', {}, el('div', { class: 'user-cell' },
            el('img', { src: pl.avatar, alt: '', loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }),
            el('div', { class: 'n' },
              el('b', {}, el('a', { href: `#/player/${pl.robloxId}` }, pl.username)),
              el('span', { class: 'mono' }, pl.robloxId)))),
          el('td', { class: 'muted' }, pl.team || '—'),
          el('td', { class: 'muted nowrap' }, playtime(Math.floor((Date.now() - pl.joinedAt) / 1000))),
          el('td', { class: 'num' }, pl.level),
          el('td', { class: 'num muted' }, pl.accountAgeDays ? `${n(pl.accountAgeDays)}d` : '—'),
          el('td', {}, pl.banned
            ? el('span', { class: 'pill err' }, 'banned')
            : pl.punishments
              ? el('span', { class: 'pill warnp' }, `${pl.punishments} prior`)
              : el('span', { class: 'muted' }, 'clean')),
          el('td', { class: 'right' },
            el('div', { class: 'btn-row', style: { justifyContent: 'flex-end' } },
              can('punish.kick')
                ? el('button', { class: 'btn sm', onclick: () => punishDialog(pl, 'kick', load) }, 'Kick')
                : null,
              can('punish.ban.temp')
                ? el('button', { class: 'btn sm danger', onclick: () => punishDialog(pl, 'ban', load) }, 'Ban')
                : null))));
      }
      table.append(tbody);
      roster.append(table);
    }

    const events = el('div', { class: 'card-body tight', style: { maxHeight: '340px', overflowY: 'auto' } });
    if (!data.events.length) {
      events.append(el('div', { class: 'empty' }, el('div', {}, 'No events from this server yet.')));
    } else {
      const t = el('table');
      const tb = el('tbody');
      for (const e of data.events) {
        tb.append(el('tr', {},
          el('td', { style: { width: '82px' } }, el('span', { class: 'pill mute' }, e.type)),
          el('td', {}, e.username || '—'),
          el('td', { class: 'muted' }, e.detail || ''),
          el('td', { class: 'muted nowrap right' }, timeAgo(e.at))));
      }
      t.append(tb);
      events.append(t);
    }

    clear(view).append(
      el('div', { class: 'toolbar' },
        el('a', { class: 'btn sm', href: '#/servers' }, '← All servers'),
        el('span', { class: 'mono muted', style: { fontSize: '12.5px' } }, s.id),
        s.status === 'online' ? el('span', { class: 'pill ok' }, 'online') : el('span', { class: 'pill err' }, 'offline'),
        el('div', { style: { marginLeft: 'auto' }, class: 'btn-row' },
          can('punish.warn')
            ? el('button', { class: 'btn sm', onclick: () => messageDialog(s.id) }, '✉ Message server')
            : null,
          can('servers.shutdown')
            ? el('button', { class: 'btn sm danger', onclick: () => shutdown(s.id) }, '⏻ Shut down')
            : null)),
      el('div', { class: 'grid stats' },
        stat('Players', `${s.players}/${s.maxPlayers || '?'}`),
        stat('Uptime', playtime(s.uptime)),
        stat('FPS', s.fps == null ? '—' : s.fps.toFixed(1)),
        stat('Ping', s.ping == null ? '—' : `${Math.round(s.ping)}ms`),
        stat('Memory', s.memory == null ? '—' : `${Math.round(s.memory)}MB`),
        stat('Region', s.region || '—'),
        stat('Version', s.version || '—'),
        stat('Last beat', timeAgo(s.lastBeat))),
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'card' },
        el('div', { class: 'card-head' }, el('h3', {}, `In this server (${data.players.length})`)),
        roster),
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'card' },
        el('div', { class: 'card-head' }, el('h3', {}, 'Server events')),
        events)
    );
  }

  async function shutdown(id) {
    const ok = await confirmDialog('Shut down server', 'Everyone in this server will be disconnected. Roblox will spin up a fresh server for new joiners.', 'Shut it down');
    if (!ok) return;
    try {
      await api(`/servers/${encodeURIComponent(id)}/shutdown`, { method: 'POST', body: { reason: 'Shut down by staff' } });
      toast('Shutdown queued - it runs on the next heartbeat.', 'ok');
    } catch (err) { toast(errMessage(err), 'err'); }
  }

  function messageDialog(id) {
    const input = el('textarea', { placeholder: 'Announcement shown to everyone in this server…', rows: 3 });
    modal({
      title: 'Message this server',
      body: el('label', { class: 'field' }, el('span', {}, 'Message'), input),
      actions: [
        { label: 'Cancel' },
        {
          kind: 'primary', label: 'Send',
          onClick: async () => {
            const message = input.value.trim();
            if (!message) return 'keep';
            await api(`/servers/${encodeURIComponent(id)}/message`, { method: 'POST', body: { message } });
            toast('Queued for the next heartbeat.', 'ok');
          },
        },
      ],
      onOpen: () => input.focus(),
    });
  }

  await load();
  const timer = setInterval(() => load().catch(() => {}), 12_000);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

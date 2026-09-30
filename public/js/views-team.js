// ============================================================
// Staff chat, staff team, game connection, audit log, appeals
// ============================================================
import {
  state, el, clear, api, toast, errMessage, can, modal, confirmDialog,
  n, timeAgo, dateTime, clock, roleBadge, on,
} from './core.js';

// ---------------------------------------------------------------
// Staff chat
// ---------------------------------------------------------------
export async function chatView(view) {
  const channels = state.meta.channels;
  if (!channels.length) {
    clear(view).append(el('div', { class: 'empty' }, el('div', {}, 'No chat rooms are open to your rank.')));
    return;
  }

  let active = sessionStorage.getItem('zhc.channel');
  if (!channels.some((c) => c.key === active)) active = channels[0].key;

  const roomList = el('div', { class: 'chat-rooms' });
  const topic = el('div', { class: 'chat-topic' });
  const log = el('div', { class: 'chat-log' });
  const online = el('div', { class: 'chat-side' });
  const input = el('textarea', {
    placeholder: 'Message the team…',
    rows: 1,
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    oninput: (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
    },
  });

  const sendBtn = el('button', { class: 'btn primary', onclick: () => send() }, 'Send');

  const layout = el('div', { class: 'chat-layout' },
    roomList,
    el('div', { class: 'chat-main' },
      topic,
      log,
      el('div', { class: 'chat-compose' },
        el('div', { class: 'box' }, input, sendBtn),
        el('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '6px' } },
          'Enter sends · Shift+Enter makes a new line · messages are logged and visible to higher ranks'))),
    online);

  clear(view).append(layout);

  function renderRooms() {
    clear(roomList);
    for (const c of channels) {
      roomList.append(el('a', {
        href: 'javascript:void 0',
        class: c.key === active ? 'active' : '',
        onclick: (e) => { e.preventDefault(); active = c.key; sessionStorage.setItem('zhc.channel', c.key); renderRooms(); loadMessages(); },
      },
        el('span', { class: 'hash' }, '#'),
        c.name,
        c.minRank > 10 ? el('span', { class: 'lock', title: `Rank ${c.minRank} and above` }, '▲') : null));
    }
  }

  function renderOnline() {
    clear(online).append(el('h4', {}, `In the panel — ${state.staffOnline.length}`));
    if (!state.staffOnline.length) {
      online.append(el('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Just you.'));
      return;
    }
    for (const s of state.staffOnline) {
      online.append(el('div', { class: 'online-row' },
        el('img', { src: s.avatar, alt: '' }),
        el('div', { style: { minWidth: 0, flex: 1 } },
          el('div', { class: 'n' }, s.username),
          el('div', { class: 'r', style: { color: s.roleColor } }, s.roleName))));
    }
  }

  let lastAuthorKey = '';

  function appendMessage(m, { scroll = true } = {}) {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    const key = `${m.userId}|${Math.floor(m.at / 300000)}`;
    const grouped = key === lastAuthorKey;
    lastAuthorKey = key;

    const node = el('div', { class: 'chat-msg', dataset: { id: m.id } },
      grouped
        ? el('div', { style: { width: '36px', flex: '0 0 auto' } })
        : el('img', { src: m.avatar || '', alt: '' }),
      el('div', { class: 'body' },
        grouped ? null : el('div', { class: 'head' },
          el('span', { class: 'author', style: { color: m.roleColor } }, m.author),
          roleBadge(m.authorRole, m.roleName, m.roleColor),
          el('span', { class: 'time' }, clock(m.at))),
        el('div', { class: `text${m.deleted ? ' gone' : ''}` },
          m.deleted ? `message deleted by ${m.deletedBy || 'staff'}` : m.body)),
      !m.deleted && (can('chat.delete') || m.userId === state.me.id)
        ? el('button', { class: 'del', title: 'Delete message', onclick: () => remove(m.id) }, '×')
        : null);

    log.append(node);
    if (scroll && atBottom) log.scrollTop = log.scrollHeight;
  }

  async function loadMessages() {
    const channel = channels.find((c) => c.key === active);
    clear(topic).append(el('b', {}, `#${channel.name}`), channel.topic ? ` — ${channel.topic}` : '');
    clear(log).append(el('div', { class: 'loading' }, 'Loading messages…'));
    lastAuthorKey = '';

    try {
      const data = await api(`/chat/${encodeURIComponent(active)}/messages?limit=80`);
      clear(log);
      if (!data.messages.length) {
        log.append(el('div', { class: 'empty' },
          el('div', { class: 'big' }, '●'),
          el('div', {}, `Nothing in #${channel.name} yet.`),
          el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } }, 'Say something.')));
        return;
      }
      for (const m of data.messages) appendMessage(m, { scroll: false });
      log.scrollTop = log.scrollHeight;
    } catch (err) {
      clear(log).append(el('div', { class: 'empty' }, el('div', {}, errMessage(err))));
    }
  }

  async function send() {
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    input.style.height = 'auto';
    try {
      await api(`/chat/${encodeURIComponent(active)}/messages`, { method: 'POST', body: { body } });
    } catch (err) {
      toast(errMessage(err), 'err');
      input.value = body;
    }
  }

  async function remove(id) {
    const ok = await confirmDialog('Delete message', 'This removes the message for everyone. The audit log keeps a copy.', 'Delete');
    if (!ok) return;
    try {
      await api(`/chat/messages/${id}`, { method: 'DELETE' });
    } catch (err) { toast(errMessage(err), 'err'); }
  }

  renderRooms();
  renderOnline();
  await loadMessages();
  input.focus();

  const offChat = on('chat', (m) => {
    if (m.message.channel !== active) {
      // Nudge the room in the list so people notice traffic elsewhere.
      const link = [...roomList.children].find((a) => a.textContent.includes(m.message.channel));
      if (link) link.style.color = 'var(--accent)';
      return;
    }
    if (log.querySelector('.empty')) clear(log);
    appendMessage(m.message);
  });

  const offDeleted = on('chat_deleted', (m) => {
    const node = log.querySelector(`[data-id="${m.id}"]`);
    if (!node) return;
    const text = node.querySelector('.text');
    text.className = 'text gone';
    text.textContent = `message deleted by ${m.by}`;
    node.querySelector('.del')?.remove();
  });

  const offPresence = on('presence', renderOnline);

  return () => { offChat(); offDeleted(); offPresence(); };
}

// ---------------------------------------------------------------
// Staff team
// ---------------------------------------------------------------
export async function staffView(view) {
  const data = await api('/staff');
  const roles = state.meta.roles;

  const render = () => {
    clear(view).append(
      el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h3', {}, `Staff team — ${data.staff.length}`),
          el('div', { class: 'spacer' }),
          el('span', { class: 'muted', style: { fontSize: '12px' } },
            can('staff.manage') ? 'You can assign any role below your own.' : 'Read-only for your rank.')),
        table(data.staff, true)),
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h3', {}, `Members without a staff role — ${data.members.length}`)),
        table(data.members, false)),
      el('div', { style: { height: '14px' } }),
      ladderCard()
    );
  };

  function table(rows, isStaffTable) {
    const body = el('div', { class: 'card-body tight' });
    if (!rows.length) {
      body.append(el('div', { class: 'empty' },
        el('div', {}, isStaffTable ? 'No staff yet.' : 'Nobody is waiting for a role.')));
      return body;
    }
    const t = el('table');
    t.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Member'), el('th', {}, 'Role'), el('th', {}, 'Roblox'),
      el('th', {}, 'Status'), el('th', {}, 'Last login'), el('th', {}, ''))));
    const tb = el('tbody');
    for (const u of rows) {
      const canManage = can('staff.manage') && u.rank < state.me.rank && u.id !== state.me.id;
      tb.append(el('tr', {},
        el('td', {}, el('div', { class: 'user-cell' },
          el('img', { src: u.avatar, alt: '', style: { borderRadius: '50%' } }),
          el('div', { class: 'n' },
            el('b', {}, u.username),
            el('span', {}, u.online ? 'in the panel now' : `@${u.handle}`)))),
        el('td', {}, roleBadge(u.role, u.roleName, u.roleColor)),
        el('td', { class: 'muted' }, u.robloxUsername || (u.robloxId ? String(u.robloxId) : '—')),
        el('td', {}, u.status === 'active'
          ? el('span', { class: 'pill ok' }, 'active')
          : el('span', { class: 'pill err' }, 'suspended')),
        el('td', { class: 'muted nowrap' }, timeAgo(u.lastLogin)),
        el('td', { class: 'right' }, el('div', { class: 'btn-row', style: { justifyContent: 'flex-end' } },
          canManage ? el('button', { class: 'btn sm', onclick: () => roleDialog(u) }, 'Change role') : null,
          canManage && can('staff.remove')
            ? el('button', {
                class: 'btn sm danger',
                onclick: () => setStatus(u, u.status === 'active' ? 'suspended' : 'active'),
              }, u.status === 'active' ? 'Suspend' : 'Restore')
            : null))));
    }
    t.append(tb);
    body.append(t);
    return body;
  }

  function ladderCard() {
    const body = el('div', { class: 'card-body' });
    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    for (const r of [...roles].sort((a, b) => b.rank - a.rank)) {
      const count = [...data.staff, ...data.members].filter((u) => u.role === r.key).length;
      list.append(el('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '7px 11px', borderRadius: '8px',
          background: r.key === state.me.role ? 'rgba(255,163,46,.08)' : 'transparent',
          border: `1px solid ${r.key === state.me.role ? 'rgba(255,163,46,.3)' : 'var(--line-soft)'}`,
        },
      },
        el('span', { style: { width: '4px', height: '20px', borderRadius: '2px', background: r.color, flex: '0 0 auto' } }),
        el('b', { style: { fontSize: '13px', minWidth: '180px' } }, r.name),
        el('span', { class: 'muted mono', style: { fontSize: '11.5px' } }, `rank ${r.rank}`),
        r.renamed
          ? el('span', { class: 'muted', style: { fontSize: '11px' } }, `was "${r.defaultName}"`)
          : null,
        el('span', { class: 'muted', style: { marginLeft: 'auto', fontSize: '12px' } },
          count ? `${count} member${count === 1 ? '' : 's'}` : '—'),
        r.key === state.me.role ? el('span', { class: 'pill info' }, 'you') : null,
        can('roles.rename')
          ? el('button', { class: 'btn sm', onclick: () => renameDialog(r) }, 'Rename')
          : null));
    }
    body.append(list,
      el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '14px' } },
        'A higher rank can always act on a lower one, and never on an equal or higher one. ',
        'Co-Owner, Creator and Game Owner are the only three ranks above Owner Assistant.',
        can('roles.rename')
          ? ' You can rename and recolour any of these; the rank order never changes.'
          : ''));
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, 'The ladder'),
        el('div', { class: 'spacer' }),
        can('roles.rename')
          ? el('span', { class: 'muted', style: { fontSize: '12px' } }, 'you can rename these')
          : null),
      body);
  }

  /** Game Owner only: rename / recolour a rank. Rank order is untouched. */
  function renameDialog(r) {
    const nameInput = el('input', { type: 'text', value: r.name, maxlength: 40 });
    const colorInput = el('input', { type: 'color', value: r.color, style: { height: '38px', padding: '3px' } });
    const preview = el('span', {
      class: 'pill role',
      style: { color: r.color, borderColor: r.color + '55', background: r.color + '18' },
    }, r.name);

    const sync = () => {
      const name = nameInput.value.trim() || r.defaultName;
      const color = colorInput.value;
      preview.textContent = name;
      preview.style.color = color;
      preview.style.borderColor = color + '55';
      preview.style.background = color + '18';
    };
    nameInput.addEventListener('input', sync);
    colorInput.addEventListener('input', sync);

    modal({
      title: `Rename rank ${r.rank}`,
      body: el('div', {},
        el('div', { style: { marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' } },
          el('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Preview:'), preview),
        el('label', { class: 'field' }, el('span', {}, 'Display name'), nameInput),
        el('label', { class: 'field' }, el('span', {}, 'Colour'), colorInput),
        el('div', { class: 'muted', style: { fontSize: '12px' } },
          `This only changes what the rank is called. It stays at rank ${r.rank}, `,
          'with exactly the same powers and the same position in the ladder. ',
          r.key === 'game_owner'
            ? 'Renaming Game Owner does not change how it is granted — that is still the environment file alone.'
            : '')),
      actions: [
        r.renamed
          ? {
              label: 'Reset to default',
              onClick: async () => {
                await api(`/roles/${r.key}`, { method: 'DELETE' });
                toast(`Reset to "${r.defaultName}".`, 'ok');
                await reloadMeta();
              },
            }
          : { label: 'Cancel' },
        {
          kind: 'primary', label: 'Save',
          onClick: async () => {
            const name = nameInput.value.trim();
            if (!name) { toast('Give the rank a name.', 'err'); return 'keep'; }
            await api(`/roles/${r.key}`, { method: 'POST', body: { name, color: colorInput.value } });
            toast(`Rank ${r.rank} is now "${name}".`, 'ok');
            await reloadMeta();
          },
        },
      ],
      onOpen: () => nameInput.focus(),
    });
  }

  /** Role names live in state.meta, so pull it fresh after a rename. */
  async function reloadMeta() {
    state.meta = await api('/meta');
    staffView(view);
  }

  function roleDialog(u) {
    const options = roles
      .filter((r) => data.assignable.includes(r.key))
      .sort((a, b) => b.rank - a.rank);
    const select = el('select', {}, ...options.map((r) => el('option', { value: r.key }, `${r.name} (rank ${r.rank})`)));
    select.value = options.some((o) => o.key === u.role) ? u.role : options[options.length - 1]?.key;

    modal({
      title: `Change role — ${u.username}`,
      body: el('div', {},
        el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' } },
          el('img', { src: u.avatar, alt: '', style: { width: '44px', height: '44px', borderRadius: '50%' } }),
          el('div', {}, el('b', {}, u.username), el('div', {}, roleBadge(u.role, u.roleName, u.roleColor)))),
        el('label', { class: 'field' }, el('span', {}, 'New role'), select),
        el('div', { class: 'muted', style: { fontSize: '12px' } },
          'You can only assign roles below your own. The change takes effect immediately.')),
      actions: [
        { label: 'Cancel' },
        {
          kind: 'primary', label: 'Apply',
          onClick: async () => {
            await api(`/staff/${u.id}/role`, { method: 'POST', body: { role: select.value } });
            toast(`${u.username} is now ${roles.find((r) => r.key === select.value)?.name}.`, 'ok');
            staffView(view);
          },
        },
      ],
    });
  }

  async function setStatus(u, status) {
    const ok = await confirmDialog(
      status === 'suspended' ? 'Suspend account' : 'Restore account',
      status === 'suspended'
        ? `${u.username} will be signed out and locked out of the panel. Their role is kept.`
        : `${u.username} will be able to sign in again.`,
      status === 'suspended' ? 'Suspend' : 'Restore'
    );
    if (!ok) return;
    try {
      await api(`/staff/${u.id}/status`, { method: 'POST', body: { status } });
      toast('Done.', 'ok');
      staffView(view);
    } catch (err) { toast(errMessage(err), 'err'); }
  }

  render();
}

// ---------------------------------------------------------------
// Game connection (API keys + setup instructions)
// ---------------------------------------------------------------
export async function keysView(view) {
  const data = await api('/apikeys');
  const origin = location.origin;

  const list = el('div', { class: 'card-body tight' });

  function renderList() {
    clear(list);
    if (!data.keys.length) {
      list.append(el('div', { class: 'empty' },
        el('div', { class: 'big' }, '⚯'),
        el('div', {}, 'No keys yet.'),
        el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          'Create one, paste it into the Roblox script, and your game is connected.')));
      return;
    }
    const t = el('table');
    t.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Label'), el('th', {}, 'Key'), el('th', {}, 'Created by'),
      el('th', {}, 'Requests'), el('th', {}, 'Last used'), el('th', {}, ''))));
    const tb = el('tbody');
    for (const k of data.keys) {
      tb.append(el('tr', { style: k.revoked ? { opacity: '.5' } : {} },
        el('td', {}, el('b', {}, k.label), k.revoked ? el('div', {}, el('span', { class: 'pill err' }, 'revoked')) : null),
        el('td', { class: 'mono muted' }, k.prefix),
        el('td', { class: 'muted' }, k.createdBy || '—'),
        el('td', { class: 'num muted' }, n(k.useCount)),
        el('td', { class: 'muted nowrap' }, k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'),
        el('td', { class: 'right' },
          !k.revoked && can('apikeys.manage')
            ? el('button', { class: 'btn sm danger', onclick: () => revoke(k) }, 'Revoke')
            : null)));
    }
    t.append(tb);
    list.append(t);
  }

  async function revoke(k) {
    const ok = await confirmDialog('Revoke key', `Any server still using "${k.label}" stops being able to reach the site immediately.`, 'Revoke');
    if (!ok) return;
    try {
      await api(`/apikeys/${k.id}`, { method: 'DELETE' });
      toast('Key revoked.', 'ok');
      keysView(view);
    } catch (err) { toast(errMessage(err), 'err'); }
  }

  function createDialog() {
    const label = el('input', { type: 'text', placeholder: 'e.g. Zah Hood - main place' });
    modal({
      title: 'Create a game key',
      body: el('div', {},
        el('label', { class: 'field' }, el('span', {}, 'Label'), label),
        el('div', { class: 'muted', style: { fontSize: '12px' } },
          'The key is shown once and never again. Store it in your game with a ServerStorage value or an environment secret, not in a LocalScript.')),
      actions: [
        { label: 'Cancel' },
        {
          kind: 'primary', label: 'Create key',
          onClick: async () => {
            const value = label.value.trim();
            if (!value) { toast('Give the key a name.', 'err'); return 'keep'; }
            const res = await api('/apikeys', { method: 'POST', body: { label: value } });
            showKey(res.key);
          },
        },
      ],
      onOpen: () => label.focus(),
    });
  }

  function showKey(key) {
    setTimeout(() => {
      modal({
        title: 'Copy this key now',
        body: el('div', {},
          el('div', { class: 'key-reveal' },
            el('b', { style: { fontSize: '12px' } }, key.label),
            el('code', {}, key.key),
            el('button', {
              class: 'btn sm',
              onclick: async (e) => {
                try {
                  await navigator.clipboard.writeText(key.key);
                  e.target.textContent = 'Copied';
                } catch { toast('Copy it manually - the browser blocked clipboard access.', 'err'); }
              },
            }, 'Copy')),
          el('div', { class: 'muted', style: { fontSize: '12.5px' } },
            'This is the only time the key is shown. If you lose it, revoke it and make a new one.')),
        actions: [{ kind: 'primary', label: 'Done', onClick: () => keysView(view) }],
      });
    }, 80);
  }

  renderList();

  const setupCode = `-- ServerScriptService/ZahHoodCentral.server.lua
local CONFIG = {
    BaseUrl = "${origin}",
    ApiKey  = "paste-your-key-here",
}`;

  clear(view).append(
    el('div', { class: 'toolbar' },
      el('div', { class: 'muted', style: { fontSize: '13px' } },
        'These keys are how your Roblox servers authenticate with this site.'),
      can('apikeys.manage')
        ? el('button', { class: 'btn primary', style: { marginLeft: 'auto' }, onclick: createDialog }, '+ New key')
        : null),
    el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Game API keys')),
      list),
    el('div', { style: { height: '14px' } }),
    el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Connecting your game')),
      el('div', { class: 'card-body' },
        el('ol', { style: { margin: '0 0 16px', paddingLeft: '20px', fontSize: '13.5px', lineHeight: '1.9' } },
          el('li', {}, 'In Roblox Studio open ', el('b', {}, 'Game Settings → Security'), ' and turn on ', el('b', {}, 'Allow HTTP Requests'), '.'),
          el('li', {}, 'Create a key above and copy it.'),
          el('li', {}, 'Drop ', el('code', { class: 'mono' }, 'ZahHoodCentral.server.lua'), ' from the project’s ', el('code', { class: 'mono' }, 'roblox/'), ' folder into ', el('b', {}, 'ServerScriptService'), '.'),
          el('li', {}, 'Fill in the two config values at the top of that script:'),
        ),
        el('div', { class: 'code-block' }, setupCode),
        el('div', { style: { height: '14px' } }),
        el('div', { class: 'kv' },
          ep('Heartbeat', 'POST /api/game/heartbeat'),
          ep('Join check', 'POST /api/game/join'),
          ep('Leave save', 'POST /api/game/leave'),
          ep('Events', 'POST /api/game/events'),
          ep('Ban sync', 'GET /api/game/bans'),
          ep('Ack actions', 'POST /api/game/ack')),
        el('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '14px' } },
          'Base URL for every endpoint: ', el('span', { class: 'mono' }, `${origin}/api/game`),
          '. Send the key as an ', el('span', { class: 'mono' }, 'X-ZHC-Key'), ' header.')))
  );

  function ep(label, path) {
    return el('div', {}, el('div', { class: 'k' }, label), el('div', { class: 'mono', style: { fontSize: '12px' } }, path));
  }
}

// ---------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------
export async function auditView(view) {
  let q = '';
  const body = el('div', { class: 'card-body tight' });
  const search = el('input', {
    type: 'search', placeholder: 'Filter by action, staff member or target…',
    oninput: debounce((e) => { q = e.target.value.trim(); load(); }, 280),
  });

  clear(view).append(
    el('div', { class: 'toolbar' }, search),
    el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Audit log'), el('div', { class: 'spacer' }),
        el('span', { class: 'muted', style: { fontSize: '12px' } }, 'every staff action, newest first')),
      body)
  );

  async function load() {
    clear(body).append(el('div', { class: 'loading' }, 'Loading…'));
    const data = await api(`/audit?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    clear(body);
    if (!data.entries.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'Nothing logged yet.')));
      return;
    }
    const t = el('table');
    t.append(el('thead', {}, el('tr', {},
      el('th', {}, 'When'), el('th', {}, 'Who'), el('th', {}, 'Action'),
      el('th', {}, 'Target'), el('th', {}, 'Detail'))));
    const tb = el('tbody');
    for (const e of data.entries) {
      tb.append(el('tr', {},
        el('td', { class: 'muted nowrap' }, dateTime(e.at)),
        el('td', {}, el('div', {}, e.actor),
          e.roleName ? el('div', {}, roleBadge(e.actorRole, e.roleName, e.roleColor)) : null),
        el('td', { class: 'mono' }, e.action),
        el('td', { class: 'mono muted' }, e.target || '—'),
        el('td', { class: 'muted', style: { maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' } }, e.detail || '')));
    }
    t.append(tb);
    body.append(t);
  }

  await load();
}

// ---------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------
export async function appealsView(view) {
  let status = 'pending';
  const body = el('div', {});
  const sel = el('select', { style: { maxWidth: '180px' }, onchange: (e) => { status = e.target.value; load(); } },
    el('option', { value: 'pending' }, 'Pending'),
    el('option', { value: 'accepted' }, 'Accepted'),
    el('option', { value: 'denied' }, 'Denied'),
    el('option', { value: 'withdrawn' }, 'Withdrawn'));

  clear(view).append(el('div', { class: 'toolbar' }, sel), body);

  async function load() {
    clear(body).append(el('div', { class: 'loading' }, 'Loading…'));
    const data = await api(`/appeals?status=${status}`);
    clear(body);

    if (!data.appeals.length) {
      body.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
        el('div', { class: 'big' }, '⚖'),
        el('div', {}, `No ${status} appeals.`))));
      return;
    }

    for (const a of data.appeals) {
      const card = el('div', { class: 'card', style: { marginBottom: '14px' } },
        el('div', { class: 'card-head' },
          el('div', { class: 'user-cell' },
            el('img', { src: a.avatar, alt: '', onerror: (e) => { e.target.style.visibility = 'hidden'; } }),
            el('div', { class: 'n' },
              el('b', {}, el('a', { href: `#/player/${a.robloxId}` }, a.username || a.robloxId)),
              el('span', {}, `appealed ${timeAgo(a.createdAt)}`))),
          el('div', { class: 'spacer' }),
          el('span', { class: a.status === 'pending' ? 'pill warnp' : a.status === 'accepted' ? 'pill ok' : 'pill err' }, a.status)),
        el('div', { class: 'card-body' },
          el('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '4px' } }, 'ORIGINAL PUNISHMENT'),
          el('div', { style: { marginBottom: '14px' } },
            el('span', { class: 'pill err' }, a.banType),
            ' ', a.banReason,
            el('span', { class: 'muted' }, a.expiresAt ? ` · until ${dateTime(a.expiresAt)}` : ' · permanent')),
          a.evidence
            ? el('div', { style: { marginBottom: '14px' } },
                el('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '4px' } }, 'EVIDENCE'),
                el('a', { href: a.evidence, target: '_blank', rel: 'noopener', class: 'mono', style: { fontSize: '11.5px', wordBreak: 'break-all' } }, a.evidence))
            : null,
          el('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '4px' } }, 'THEIR APPEAL'),
          el('div', { style: { whiteSpace: 'pre-wrap', fontSize: '13.5px' } }, a.body),
          a.response
            ? el('div', { style: { marginTop: '14px' } },
                el('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '4px' } }, `RULING BY ${(a.handledBy || '').toUpperCase()}`),
                el('div', { style: { fontSize: '13.5px' } }, a.response))
            : null),
        el('div', { class: 'card-body', style: { borderTop: '1px solid var(--line-soft)' } },
          el('div', { class: 'btn-row' },
            can('appeals.chat')
              ? el('button', { class: 'btn', onclick: () => openThread(a) },
                  `✉ Conversation${a.messages ? ` (${a.messages})` : ''}`)
              : null,
            a.status === 'pending' && can('appeals.review')
              ? el('button', { class: 'btn primary', onclick: () => decide(a, 'accepted') }, '✓ Accept & lift ban')
              : null,
            a.status === 'pending' && can('appeals.review')
              ? el('button', { class: 'btn danger', onclick: () => decide(a, 'denied') }, '× Deny')
              : null)));
      body.append(card);
    }
  }

  /** The back-and-forth with the appellant. Moderator and above. */
  async function openThread(appeal) {
    let data;
    try {
      data = await api(`/appeals/${appeal.id}/messages`);
    } catch (err) { toast(errMessage(err), 'err'); return; }

    const log = el('div', { class: 'appeal-log', style: { maxHeight: '320px' } });
    const input = el('textarea', { rows: 2, placeholder: 'Reply to the player…' });

    const paint = (messages) => {
      clear(log);
      if (!messages.length) {
        log.append(el('div', { class: 'appeal-system' }, 'Nothing said yet.'));
        return;
      }
      for (const m of messages) {
        if (m.from === 'system') {
          log.append(el('div', { class: 'appeal-system' }, m.body));
          continue;
        }
        log.append(el('div', { class: `appeal-msg ${m.from}` },
          el('div', { class: 'appeal-msg-head' },
            el('span', { style: m.roleColor ? { color: m.roleColor } : {} },
              m.from === 'staff' ? `${m.author}${m.roleName ? ` · ${m.roleName}` : ''}` : m.author),
            el('span', { class: 'appeal-time' }, timeAgo(m.at))),
          el('div', { class: 'appeal-msg-body' }, m.body)));
      }
      log.scrollTop = log.scrollHeight;
    };
    paint(data.messages);

    const send = async () => {
      const body = input.value.trim();
      if (!body) return;
      input.value = '';
      try {
        await api(`/appeals/${appeal.id}/messages`, { method: 'POST', body: { body } });
        const fresh = await api(`/appeals/${appeal.id}/messages`);
        paint(fresh.messages);
      } catch (err) { toast(errMessage(err), 'err'); input.value = body; }
    };
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

    modal({
      title: `Appeal #${appeal.id} — ${data.appeal.username}`,
      body: el('div', {},
        el('div', { class: 'appeal-ban-note' },
          el('b', {}, 'Ban: '), data.appeal.ban.reason,
          data.appeal.ban.evidence
            ? el('div', { style: { marginTop: '6px' } },
                el('a', { href: data.appeal.ban.evidence, target: '_blank', rel: 'noopener', class: 'mono', style: { fontSize: '11px', wordBreak: 'break-all' } }, data.appeal.ban.evidence))
            : null),
        log,
        data.appeal.status === 'pending'
          ? el('div', { class: 'appeal-compose' },
              el('div', { style: { display: 'flex', gap: '8px' } },
                input,
                el('button', { class: 'btn primary', onclick: send }, 'Send')),
              el('div', { class: 'note', style: { marginTop: '8px' } },
                'The player sees your rank, not your name. Other staff here see both.'))
          : el('div', { class: 'note', style: { marginTop: '12px' } }, 'This appeal is closed.')),
      actions: [{ label: 'Close', onClick: () => { appealsView(view); } }],
      onOpen: () => input.focus(),
    });
  }

  function decide(appeal, decision) {
    const response = el('textarea', {
      rows: 3,
      placeholder: decision === 'accepted'
        ? 'What you want them to know before they come back…'
        : 'Why the appeal was denied…',
    });
    modal({
      title: decision === 'accepted' ? 'Accept appeal' : 'Deny appeal',
      body: el('div', {},
        el('label', { class: 'field' }, el('span', {}, 'Response to the player'), response),
        el('div', { class: 'muted', style: { fontSize: '12px' } },
          decision === 'accepted'
            ? 'Accepting lifts the ban immediately. You can only lift bans issued by someone below your rank.'
            : 'The ban stays exactly as it is.')),
      actions: [
        { label: 'Cancel' },
        {
          kind: decision === 'accepted' ? 'primary' : 'danger',
          label: decision === 'accepted' ? 'Accept' : 'Deny',
          onClick: async () => {
            await api(`/appeals/${appeal.id}`, { method: 'POST', body: { decision, response: response.value.trim() } });
            toast(decision === 'accepted' ? 'Appeal accepted, ban lifted.' : 'Appeal denied.', 'ok');
            load();
          },
        },
      ],
      onOpen: () => response.focus(),
    });
  }

  await load();
}

// ---------------------------------------------------------------
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

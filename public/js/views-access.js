// ============================================================
// Access control: whitelist, sessions, rejected logins
// ============================================================
import {
  state, el, clear, api, toast, errMessage, can, modal, confirmDialog,
  n, timeAgo, dateTime, roleBadge,
} from './core.js';

export async function accessView(view) {
  const [wl, sec] = await Promise.all([api('/whitelist'), api('/security')]);

  const render = () => {
    clear(view).append(
      postureCard(sec),
      el('div', { style: { height: '14px' } }),
      whitelistCard(wl),
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'grid two' }, rejectedCard(sec), sessionsCard(sec))
    );
  };

  // ---------------- posture ----------------
  function postureCard(s) {
    const body = el('div', { class: 'card-body' });

    const rows = [
      {
        label: 'Whitelist',
        on: s.whitelistEnabled,
        good: 'Only approved Discord IDs can sign in',
        bad: 'OFF - anyone with a Discord account can sign in',
        toggle: can('settings.manage'),
      },
      {
        label: 'Discord server lock',
        on: !!s.guildLock,
        good: `Locked to server ${s.guildLock}`,
        bad: 'Not set - membership of your Discord is not required',
      },
      {
        label: 'Game Owner source',
        on: s.ownerConfigured,
        good: 'Set from the server environment file only',
        bad: 'OWNER_DISCORD_ID is unset - nobody can hold Game Owner',
      },
    ];

    for (const r of rows) {
      body.append(
        el('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '12px',
            padding: '11px 0', borderBottom: '1px solid var(--line-soft)',
          },
        },
          el('span', {
            style: {
              width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto',
              background: r.on ? 'var(--good)' : 'var(--warn)',
            },
          }),
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('b', { style: { fontSize: '13px' } }, r.label),
            el('div', { class: 'muted', style: { fontSize: '12.5px' } }, r.on ? r.good : r.bad)),
          r.toggle
            ? el('button', {
                class: `btn sm ${r.on ? 'danger' : 'primary'}`,
                onclick: () => toggleWhitelist(!r.on),
              }, r.on ? 'Turn off' : 'Turn on')
            : null)
      );
    }

    for (const p of s.config.problems) {
      body.append(el('div', { class: 'alert', style: { marginTop: '12px', marginBottom: 0 } }, p));
    }
    for (const w of s.config.warnings) {
      body.append(el('div', {
        class: 'alert',
        style: {
          marginTop: '12px', marginBottom: 0,
          background: 'rgba(255,200,87,.08)', borderColor: 'rgba(255,200,87,.3)', color: '#ffe0a0',
        },
      }, w));
    }

    body.append(el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '14px' } },
      'Game Owner cannot be granted, changed or removed from this panel by anyone, at any rank. ',
      'It is read from OWNER_DISCORD_ID in the server’s environment file on every login. ',
      'An account holding it without matching that value is demoted automatically.'));

    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, 'Security posture'),
        el('div', { class: 'spacer' }),
        el('span', { class: 'muted', style: { fontSize: '12px' } },
          `${n(s.rejected24h)} rejected sign-in${s.rejected24h === 1 ? '' : 's'} in 24h`)),
      body);
  }

  async function toggleWhitelist(enabled) {
    if (!enabled) {
      const ok = await confirmDialog(
        'Turn the whitelist off',
        'Anyone with a Discord account will then be able to sign in. They arrive with no staff role, but they get an account and show up in your user list. Leave it on unless you have a reason.',
        'Turn it off'
      );
      if (!ok) return;
    }
    try {
      await api('/whitelist/enabled', { method: 'POST', body: { enabled } });
      toast(enabled ? 'Whitelist is on.' : 'Whitelist is off.', enabled ? 'ok' : 'err');
      accessView(view);
    } catch (err) { toast(errMessage(err), 'err'); }
  }

  // ---------------- whitelist ----------------
  function whitelistCard(data) {
    const body = el('div', { class: 'card-body tight' });

    if (!data.entries.length) {
      body.append(el('div', { class: 'empty' },
        el('div', { class: 'big' }, '⚿'),
        el('div', {}, 'Nobody is whitelisted yet.'),
        el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          'Only you, as the configured owner, can sign in right now.')));
    } else {
      const t = el('table');
      t.append(el('thead', {}, el('tr', {},
        el('th', {}, 'Discord ID'), el('th', {}, 'Who'), el('th', {}, 'Status'),
        el('th', {}, 'Added by'), el('th', {}, 'Added'), el('th', {}, ''))));
      const tb = el('tbody');
      for (const e of data.entries) {
        const isOwner = e.discordId === data.ownerId;
        tb.append(el('tr', {},
          el('td', { class: 'mono' }, e.discordId),
          el('td', {},
            el('div', {}, el('b', {}, e.label || e.username || '—')),
            e.username && e.label ? el('div', { class: 'muted', style: { fontSize: '11.5px' } }, `@${e.username}`) : null,
            e.note ? el('div', { class: 'muted', style: { fontSize: '11.5px' } }, e.note) : null),
          el('td', {},
            isOwner ? el('span', { class: 'pill err' }, 'owner') : null,
            e.hasLoggedIn
              ? roleBadge(e.role, e.roleName)
              : el('span', { class: 'pill mute' }, 'never signed in')),
          el('td', { class: 'muted' }, e.addedBy || '—'),
          el('td', { class: 'muted nowrap' }, timeAgo(e.addedAt)),
          el('td', { class: 'right' },
            can('whitelist.manage') && !isOwner
              ? el('button', { class: 'btn sm danger', onclick: () => remove(e) }, 'Revoke')
              : null)));
      }
      t.append(tb);
      body.append(t);
    }

    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, `Whitelist — ${data.entries.length}`),
        el('div', { class: 'spacer' }),
        can('whitelist.manage')
          ? el('button', { class: 'btn primary sm', onclick: addDialog }, '+ Whitelist someone')
          : null),
      body);
  }

  function addDialog() {
    const idInput = el('input', { type: 'text', placeholder: '18-digit Discord user ID' });
    const labelInput = el('input', { type: 'text', placeholder: 'Who is this? e.g. Trell - head mod' });
    const noteInput = el('input', { type: 'text', placeholder: 'Optional note' });

    modal({
      title: 'Add to the whitelist',
      body: el('div', {},
        el('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '14px' } },
          'They still have to sign in with Discord once before you can give them a staff role. ',
          'Whitelisting only opens the door.'),
        el('label', { class: 'field' }, el('span', {}, 'Discord user ID'), idInput),
        el('label', { class: 'field' }, el('span', {}, 'Label'), labelInput),
        el('label', { class: 'field' }, el('span', {}, 'Note'), noteInput),
        el('div', { class: 'muted', style: { fontSize: '12px' } },
          'To get their ID: Discord → Settings → Advanced → Developer Mode on, then right-click them → Copy User ID.')),
      actions: [
        { label: 'Cancel' },
        {
          kind: 'primary', label: 'Add',
          onClick: async () => {
            const discordId = idInput.value.trim();
            if (!/^\d{17,20}$/.test(discordId)) {
              toast('That does not look like a Discord user ID.', 'err');
              return 'keep';
            }
            await api('/whitelist', {
              method: 'POST',
              body: { discordId, label: labelInput.value.trim(), note: noteInput.value.trim() },
            });
            toast('Added to the whitelist.', 'ok');
            accessView(view);
          },
        },
      ],
      onOpen: () => idInput.focus(),
    });
  }

  async function remove(entry) {
    const who = entry.label || entry.username || entry.discordId;
    const ok = await confirmDialog(
      'Revoke access',
      `${who} will be signed out immediately and will not be able to sign back in. Their account, staff role and history are kept.`,
      'Revoke access'
    );
    if (!ok) return;
    try {
      await api(`/whitelist/${entry.discordId}`, { method: 'DELETE' });
      toast('Access revoked.', 'ok');
      accessView(view);
    } catch (err) { toast(errMessage(err), 'err'); }
  }

  // ---------------- rejected logins ----------------
  function rejectedCard(s) {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '340px', overflowY: 'auto' } });
    if (!s.rejectedLogins.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'No rejected sign-ins.')));
    } else {
      const t = el('table');
      const tb = el('tbody');
      const REASONS = {
        not_whitelisted: ['not whitelisted', 'warnp'],
        not_in_guild: ['not in Discord server', 'warnp'],
        suspended: ['account suspended', 'err'],
      };
      for (const r of s.rejectedLogins) {
        const [label, pill] = REASONS[r.reason] || [r.reason, 'mute'];
        tb.append(el('tr', {},
          el('td', {},
            el('div', {}, el('b', {}, r.username || '—')),
            el('div', { class: 'mono muted', style: { fontSize: '11px' } }, r.discordId || '')),
          el('td', {}, el('span', { class: `pill ${pill}` }, label)),
          el('td', { class: 'muted nowrap right' }, timeAgo(r.at))));
      }
      t.append(tb);
      body.append(t);
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, 'Rejected sign-ins'),
        el('div', { class: 'spacer' }),
        el('span', { class: 'muted', style: { fontSize: '12px' } }, 'last 7 days')),
      body);
  }

  // ---------------- sessions ----------------
  function sessionsCard(s) {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '340px', overflowY: 'auto' } });
    if (!s.sessions.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'No active sessions.')));
    } else {
      const t = el('table');
      const tb = el('tbody');
      for (const sess of s.sessions) {
        tb.append(el('tr', {},
          el('td', {},
            el('div', {}, el('b', {}, sess.username), sess.isYou ? el('span', { class: 'pill info', style: { marginLeft: '6px' } }, 'you') : null),
            el('div', {}, roleBadge(sess.role, sess.roleName))),
          el('td', { class: 'muted', style: { fontSize: '12px' } },
            el('div', {}, sess.device),
            el('div', { class: 'mono', style: { fontSize: '11px' } }, sess.ip || '')),
          el('td', { class: 'muted nowrap right' }, timeAgo(sess.lastUsed || sess.createdAt)),
          el('td', { class: 'right' },
            can('staff.remove') && !sess.isYou
              ? el('button', { class: 'btn sm', onclick: () => revokeSessions(sess) }, 'Sign out')
              : null)));
      }
      t.append(tb);
      body.append(t);
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Active sessions')),
      body);
  }

  async function revokeSessions(sess) {
    const ok = await confirmDialog('Sign out everywhere',
      `${sess.username} will be signed out of every device. They can sign back in unless you also revoke their whitelist entry.`,
      'Sign them out');
    if (!ok) return;
    try {
      await api('/security/sessions/revoke', { method: 'POST', body: { userId: sess.userId } });
      toast('Sessions revoked.', 'ok');
      accessView(view);
    } catch (err) { toast(errMessage(err), 'err'); }
  }

  render();
}

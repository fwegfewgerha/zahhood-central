// ============================================================
// Chat moderation - Discord mutes.
// Visible to Chat Moderator and every rank above.
// ============================================================
import {
  state, el, clear, api, toast, errMessage, can, modal, confirmDialog,
  n, timeAgo, dateTime, duration, roleBadge, on,
} from './core.js';

const DURATIONS = [
  ['60s', '1 minute'],
  ['5m', '5 minutes'],
  ['10m', '10 minutes'],
  ['1h', '1 hour'],
  ['6h', '6 hours'],
  ['1d', '1 day'],
  ['7d', '1 week'],
  ['28d', '28 days (Discord maximum)'],
];

export async function chatmodView(view) {
  let data = await api('/chatmod');

  const render = () => {
    clear(view).append(
      botCard(),
      el('div', { style: { height: '14px' } }),
      el('div', { class: 'grid stats' },
        stat('Muted right now', n(data.stats.activeCount), 'active Discord timeouts', 'warn'),
        stat('Mutes today', n(data.stats.last24h), 'across the whole team'),
        stat('Issued by you', n(data.stats.mine), 'all time')),
      el('div', { style: { height: '14px' } }),
      lookupCard(),
      el('div', { style: { height: '14px' } }),
      activeCard(),
      el('div', { style: { height: '14px' } }),
      historyCard(),
      el('div', { style: { height: '14px' } }),
      anonymityNote()
    );
  };

  // ---------------- bot status ----------------
  function botCard() {
    const b = data.bot;
    const body = el('div', { class: 'card-body' });

    if (b.ok) {
      body.append(el('div', { class: 'kv' },
        kv('Bot', b.bot.username),
        kv('Server', b.guild.name),
        kv('Status', el('span', { class: 'pill ok' }, 'connected'))));
    } else {
      body.append(
        el('div', { class: 'alert', style: { marginBottom: '14px' } },
          el('b', {}, 'The bot is not usable yet. '), b.error || 'Unknown problem.'),
        el('ol', { class: 'muted', style: { fontSize: '12.5px', margin: '0 0 14px', paddingLeft: '18px', lineHeight: '1.9' } },
          el('li', {}, 'Developer Portal → your app → ', el('b', {}, 'Bot'), ' → Reset Token, and copy it.'),
          el('li', {}, 'Put it in ', el('span', { class: 'mono' }, 'DISCORD_BOT_TOKEN'), ' on the server, then restart.'),
          el('li', {}, 'Invite the bot with the link below. It asks for ', el('b', {}, 'Moderate Members'), ' and nothing else.'),
          el('li', {}, 'In Server Settings → Roles, drag the bot’s role ', el('b', {}, 'above'),
            ' everyone it should be able to mute. Discord will not let it touch anyone at or above its own role.')),
        data.inviteUrl
          ? el('div', {},
              el('a', { class: 'btn primary sm', href: data.inviteUrl, target: '_blank', rel: 'noopener' },
                'Invite the bot (Moderate Members only)'),
              el('div', { class: 'code-block', style: { marginTop: '10px', fontSize: '11px', whiteSpace: 'pre-wrap' } },
                data.inviteUrl))
          : el('div', { class: 'muted', style: { fontSize: '12px' } },
              'Set DISCORD_CLIENT_ID to generate an invite link.'));
    }

    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, 'Discord connection'),
        el('div', { class: 'spacer' }),
        b.ok ? el('span', { class: 'pill ok' }, 'ready') : el('span', { class: 'pill err' }, 'not ready')),
      body);
  }

  // ---------------- lookup + mute ----------------
  function lookupCard() {
    const input = el('input', {
      type: 'text',
      placeholder: 'Discord username or user ID…',
      onkeydown: (e) => { if (e.key === 'Enter') doLookup(); },
    });
    const results = el('div', { class: 'card-body tight' });

    async function doLookup() {
      const q = input.value.trim();
      if (!q) return;
      clear(results).append(el('div', { class: 'loading' }, 'Searching Discord…'));
      try {
        const found = await api(`/chatmod/lookup?q=${encodeURIComponent(q)}`);
        clear(results);
        if (!found.members.length) {
          results.append(el('div', { class: 'empty' },
            el('div', {}, 'Nobody in your Discord server matches that.'),
            el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
              'Searching by name needs an exact-ish match. A user ID always works.')));
          return;
        }
        const t = el('table');
        t.append(el('thead', {}, el('tr', {},
          el('th', {}, 'Person'), el('th', {}, 'Discord ID'),
          el('th', {}, 'Status'), el('th', {}, 'Record'), el('th', {}, ''))));
        const tb = el('tbody');
        for (const m of found.members) {
          tb.append(el('tr', {},
            el('td', {}, el('div', { class: 'user-cell' },
              el('img', { src: m.avatar, alt: '', style: { borderRadius: '50%' } }),
              el('div', { class: 'n' },
                el('b', {}, m.displayName),
                el('span', {}, `@${m.username}`)))),
            el('td', { class: 'mono muted', style: { fontSize: '11.5px' } }, m.discordId),
            el('td', {}, m.timedOutUntil
              ? el('span', { class: 'pill warnp' }, `muted · ${duration(m.timedOutUntil - Date.now())} left`)
              : el('span', { class: 'pill ok' }, 'not muted')),
            el('td', {}, m.priorMutes
              ? el('div', {},
                  el('span', { class: m.priorMutes >= 3 ? 'pill err' : 'pill warnp' },
                    `${m.priorMutes} prior mute${m.priorMutes === 1 ? '' : 's'}`),
                  m.mutesLast30Days
                    ? el('div', { class: 'muted', style: { fontSize: '11px', marginTop: '3px' } },
                        `${m.mutesLast30Days} in the last 30 days`)
                    : null)
              : el('span', { class: 'muted', style: { fontSize: '12px' } }, 'clean record')),
            el('td', { class: 'right' },
              can('chatmod.mute') && data.bot.ok
                ? el('button', { class: 'btn sm danger', onclick: () => muteDialog(m) }, 'Mute')
                : null)));
        }
        t.append(tb);
        results.append(t);
      } catch (err) {
        clear(results).append(el('div', { class: 'empty' }, el('div', {}, errMessage(err))));
      }
    }

    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Find someone')),
      el('div', { class: 'card-body', style: { paddingBottom: '0' } },
        el('div', { class: 'toolbar', style: { marginBottom: '12px' } },
          input,
          el('button', { class: 'btn primary', onclick: doLookup, disabled: !data.bot.ok }, 'Search'))),
      results);
  }

  function muteDialog(member) {
    const reason = el('textarea', { rows: 3, placeholder: 'Why are they being muted? Staff see this; Discord does not.' });
    const dur = el('select', {}, ...DURATIONS.map(([v, label]) => el('option', { value: v }, label)));
    dur.value = '10m';

    // A mute cannot be issued without a screenshot, so the dialog makes that
    // the first thing you see rather than a surprise at the end.
    let evidenceId = null;
    let muteBtn = null;
    const preview = el('div', { class: 'shot-preview' });
    const fileInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/gif,image/webp',
      style: { display: 'none' },
    });
    const drop = el('div', { class: 'shot-drop' },
      el('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, 'Screenshot required'),
      el('div', { class: 'muted', style: { fontSize: '12px' } },
        'Paste with Ctrl+V, drop an image here, or ',
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); fileInput.click(); } }, 'choose a file')));

    const refreshMuteButton = () => {
      if (!muteBtn) return;
      muteBtn.disabled = !evidenceId;
      muteBtn.title = evidenceId ? '' : 'Attach a screenshot first';
    };
    const setStatus = (node) => { clear(preview); if (node) preview.append(node); };

    async function upload(file) {
      if (!file) return;
      if (!/^image\//.test(file.type)) { toast('That is not an image.', 'err'); return; }
      if (file.size > 4 * 1024 * 1024) { toast('That image is over 4MB. Crop it or save it smaller.', 'err'); return; }

      setStatus(el('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Uploading\u2026'));
      let dataUrl;
      try {
        dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(file);
        });
      } catch {
        toast('Could not read that file.', 'err');
        setStatus(null);
        return;
      }

      try {
        const up = await api('/chatmod/evidence', { method: 'POST', body: { image: dataUrl } });
        evidenceId = up.evidenceId;
        drop.style.display = 'none';
        setStatus(el('div', {},
          el('img', { src: dataUrl, class: 'shot-img', alt: 'Evidence' }),
          el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' } },
            el('span', { class: 'pill ok' }, 'attached \u00b7 ' + Math.round(up.bytes / 1024) + ' KB'),
            el('button', {
              class: 'btn sm',
              onclick: () => {
                evidenceId = null;
                setStatus(null);
                drop.style.display = '';
                refreshMuteButton();
              },
            }, 'Remove'))));
      } catch (err) {
        toast(errMessage(err), 'err');
        setStatus(null);
      }
      refreshMuteButton();
    }

    fileInput.onchange = (e) => upload(e.target.files && e.target.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      upload(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    };

    const onPaste = (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const item = [...items].find((i) => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); upload(item.getAsFile()); }
    };
    document.addEventListener('paste', onPaste);
    const done = () => document.removeEventListener('paste', onPaste);

    modal({
      title: 'Mute ' + member.displayName,
      body: el('div', {},
        el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' } },
          el('img', { src: member.avatar, alt: '', style: { width: '44px', height: '44px', borderRadius: '50%' } }),
          el('div', {},
            el('b', {}, member.displayName),
            el('div', { class: 'mono muted', style: { fontSize: '11.5px' } }, member.discordId))),
        drop, preview, fileInput,
        el('label', { class: 'field', style: { marginTop: '14px' } }, el('span', {}, 'Duration'), dur),
        el('label', { class: 'field' }, el('span', {}, 'Reason'), reason),
        el('div', {
          style: {
            fontSize: '12px', padding: '10px 12px', borderRadius: '8px',
            background: 'rgba(74,168,255,.08)', border: '1px solid rgba(74,168,255,.25)', color: '#a9d4ff',
          },
        },
          el('b', {}, 'You stay anonymous. '),
          'Discord records the bot as the one who muted them. Your name and the screenshot stay here, where staff can see them, and are never sent to Discord.')),
      actions: [
        { label: 'Cancel', onClick: done },
        {
          kind: 'danger',
          label: 'Mute',
          onClick: async () => {
            if (!evidenceId) { toast('Attach a screenshot of what they said.', 'err'); return 'keep'; }
            const body = reason.value.trim();
            if (!body) { toast('A reason is required.', 'err'); return 'keep'; }
            const result = await api('/chatmod/mute', {
              method: 'POST',
              body: {
                discordId: member.discordId,
                name: member.displayName,
                reason: body,
                duration: dur.value,
                evidenceId,
              },
            });
            done();
            toast(member.displayName + ' muted.', 'ok');
            if (result.cappedTo28Days) toast('Shortened to 28 days, which is Discord\u2019s limit.', '');
            chatmodView(view);
          },
        },
      ],
      onOpen: (box) => {
        muteBtn = [...box.querySelectorAll('footer .btn')].find((b) => b.textContent === 'Mute');
        refreshMuteButton();
        reason.focus();
      },
    });
  }

  function viewEvidence(mute) {
    modal({
      title: 'Evidence \u2014 ' + (mute.name || mute.discordId),
      body: el('div', {},
        el('div', { class: 'appeal-ban-note' }, el('b', {}, 'Reason: '), mute.reason),
        el('img', { src: '/api/chatmod/evidence/' + mute.evidenceId, class: 'shot-img', alt: 'Evidence' })),
      actions: [{ label: 'Close' }],
    });
  }

  // ---------------- active mutes ----------------
  function activeCard() {
    const body = el('div', { class: 'card-body tight' });
    if (!data.active.length) {
      body.append(el('div', { class: 'empty' },
        el('div', { class: 'big' }, '♪'),
        el('div', {}, 'Nobody is muted right now.')));
    } else {
      body.append(muteTable(data.active, true));
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', {}, `Currently muted — ${data.active.length}`),
        el('div', { class: 'spacer' }),
        el('span', { class: 'muted', style: { fontSize: '12px' } }, 'Discord lifts these automatically when they expire')),
      body);
  }

  function historyCard() {
    const body = el('div', { class: 'card-body tight', style: { maxHeight: '380px', overflowY: 'auto' } });
    if (!data.history.length) {
      body.append(el('div', { class: 'empty' }, el('div', {}, 'No mutes have been issued yet.')));
    } else {
      body.append(muteTable(data.history, false));
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Mute history')), body);
  }

  function muteTable(rows, showLift) {
    const t = el('table');
    t.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Person'), el('th', {}, 'Reason'), el('th', {}, 'Muted by'),
      el('th', {}, 'When'), el('th', {}, showLift ? 'Ends' : 'Status'), el('th', {}, ''))));
    const tb = el('tbody');
    for (const m of rows) {
      const canLift = can('chatmod.unmute') && m.active &&
        (m.issuedById === state.me.id || (m.issuedByRole && state.me.rank > rankOfRole(m.issuedByRole)));
      tb.append(el('tr', {},
        el('td', {},
          el('div', {}, el('b', {}, m.name || '—')),
          el('div', { class: 'mono muted', style: { fontSize: '11px' } }, m.discordId)),
        el('td', { style: { maxWidth: '260px' } }, m.reason),
        el('td', {},
          el('div', {}, m.issuedBy || '—'),
          m.issuedByRoleName
            ? el('div', {}, roleBadge(m.issuedByRole, m.issuedByRoleName, m.issuedByRoleColor))
            : null),
        el('td', { class: 'muted nowrap' }, timeAgo(m.issuedAt)),
        el('td', { class: 'nowrap' }, m.active
          ? (m.expiresAt
              ? el('span', { class: 'pill warnp' }, `${duration(m.expiresAt - Date.now())} left`)
              : el('span', { class: 'pill warnp' }, 'active'))
          : m.revokedBy
            ? el('span', { class: 'pill mute' }, `lifted by ${m.revokedBy}`)
            : el('span', { class: 'pill mute' }, 'expired')),
        el('td', { class: 'right' },
          el('div', { class: 'btn-row', style: { justifyContent: 'flex-end' } },
            m.evidenceAvailable && can('chatmod.evidence')
              ? el('button', { class: 'btn sm', onclick: () => viewEvidence(m) }, 'Screenshot')
              : m.evidenceExpired
                ? el('span', { class: 'pill mute', title: 'The mute record is kept for good; the image is not.' }, 'shot expired')
                : null,
            canLift ? el('button', { class: 'btn sm', onclick: () => lift(m) }, 'Lift') : null))));
    }
    t.append(tb);
    return t;
  }

  function rankOfRole(key) {
    return state.meta?.roles?.find((r) => r.key === key)?.rank ?? 0;
  }

  async function lift(m) {
    const ok = await confirmDialog('Lift the mute',
      `${m.name || m.discordId} will be able to talk in Discord again immediately.`, 'Lift it');
    if (!ok) return;
    try {
      await api(`/chatmod/unmute/${m.id}`, { method: 'POST', body: { reason: 'Lifted from the chat moderation page' } });
      toast('Mute lifted.', 'ok');
      chatmodView(view);
    } catch (err) { toast(errMessage(err), 'err'); }
  }

  function anonymityNote() {
    return el('div', { class: 'card' },
      el('div', { class: 'card-body' },
        el('div', { style: { fontSize: '13px', marginBottom: '10px' } }, el('b', {}, 'How anonymity works here')),
        el('ul', { class: 'muted', style: { fontSize: '12.5px', margin: 0, paddingLeft: '18px', lineHeight: '1.9' } },
          el('li', {}, 'Discord records the ', el('b', {}, 'bot'), ' as the account that applied the timeout. Nobody in the server can see a staff name.'),
          el('li', {}, 'The audit-log reason Discord stores is a fixed string, so it carries nothing about who ordered it.'),
          el('li', {}, 'Your name is kept ', el('b', {}, 'here'), ', on this page and in the audit log, so the team stays accountable to each other.'),
          el('li', {}, 'Mutes last at most 28 days, which is Discord’s own limit, and Discord lifts them on time without the panel doing anything.'),
          el('li', {}, 'You can only lift a mute issued by a rank below yours, or one you issued yourself.'),
          el('li', {}, 'Every mute needs a screenshot. The server refuses one without it, so it cannot be skipped by anybody at any rank.'),
          el('li', {}, `Screenshots are deleted after ${data.evidenceRetentionDays || 90} days to keep the database small. The mute itself is kept for good, so somebody’s record follows them however long it has been.`),
          el('li', {}, 'The bot has no slash commands and never connects to Discord’s gateway, so nothing inside Discord can tell it to act. This website is its only caller.'),
          el('li', {}, 'Its code is locked to timeouts: reads to find someone, and one write that may only set a timeout. Banning, kicking, posting and role changes are refused before the request is sent.'))));
  }

  function kv(k, v) {
    return el('div', {}, el('div', { class: 'k' }, k), el('div', { class: 'v', style: { fontSize: '14px' } }, v));
  }
  function stat(label, value, detail, kind) {
    return el('div', { class: `stat ${kind || ''}` },
      el('div', { class: 'k' }, label), el('div', { class: 'v' }, value), el('div', { class: 'd' }, detail));
  }

  render();

  const offMute = on('chat_mute', async () => {
    try { data = await api('/chatmod'); render(); } catch { /* keep showing what we have */ }
  });
  const offUnmute = on('chat_unmute', async () => {
    try { data = await api('/chatmod'); render(); } catch { /* ignore */ }
  });
  return () => { offMute(); offUnmute(); };
}

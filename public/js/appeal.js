// ============================================================
// Appeal flow, from the player's side.
//
//   sign in with Discord
//     -> name your Roblox account
//     -> prove it is yours with a profile phrase
//     -> see the reason and the clip
//     -> appeal, or walk away
//     -> talk to staff until they rule
// ============================================================
import { el, clear, api, toast, errMessage, dateTime, timeAgo, duration } from '/js/core.js';

const root = document.getElementById('content');

const ERRORS = {
  roblox_user_not_found: 'No Roblox account with that name. Check the spelling, or paste your user ID instead.',
  roblox_already_claimed: 'Another Discord account has already verified that Roblox user.',
  roblox_not_verified: 'Verify your Roblox account first.',
  description_empty: 'Your Roblox About section is empty. Paste the phrase in and save, then try again.',
  phrase_not_found: 'The phrase is not in your About section yet. Roblox can take a moment to save - wait a few seconds and try again.',
  roblox_unreachable: 'Roblox is not responding right now. Try again in a minute.',
  no_pending_verification: 'That verification expired. Start again.',
  appeals_closed: 'Appeals are closed at the moment.',
  appeal_too_short: 'Write a bit more - at least a couple of sentences.',
  no_active_ban: 'That account is not banned.',
  appeal_already_open_by_someone_else: 'There is already an appeal open for that ban.',
  rate_limited: 'Too many attempts. Wait a few minutes.',
};
const msg = (e) => ERRORS[e?.message] || errMessage(e);

function card(...kids) {
  clear(root).append(...kids);
}
function heading(t, sub) {
  return el('div', { style: { marginBottom: '18px' } },
    el('div', { style: { fontSize: '15px', fontWeight: 650, marginBottom: '4px' } }, t),
    sub ? el('div', { class: 'muted', style: { fontSize: '12.5px' } }, sub) : null);
}
function signedInAs(cfg) {
  return el('p', { class: 'note', style: { textAlign: 'center', marginTop: 0 } },
    'Signed in as ', el('b', {}, cfg.me?.username || 'you'), ' · ',
    el('a', { href: '/auth/logout' }, 'Sign out'));
}

// ---------------------------------------------------------------
async function boot() {
  const cfg = await fetch('/api/appeal/config', { credentials: 'same-origin' }).then((r) => r.json());

  if (!cfg.open) {
    return card(el('div', { class: 'alert' },
      'Appeals are closed at the moment. Check back later, or ask in the Discord.'));
  }
  if (!cfg.signedIn) {
    return card(
      heading('Sign in first', 'We need to know the appeal is really from you. You do not have to be staff, and you do not have to be in the Discord server.'),
      el('a', { class: 'btn-discord', href: '/auth/discord?next=/appeal' }, 'Continue with Discord'));
  }

  // Already have an appeal on the go? Go straight to the conversation.
  const mine = await api('/appeal/mine').catch(() => ({ appeal: null }));
  if (mine.appeal) return showThread(cfg, mine.appeal);

  const status = await api('/appeal/verify/status').catch(() => ({}));
  if (status.pending) return showVerify(cfg, status.pending, null);
  if (status.accounts?.length) return chooseAccount(cfg, status.accounts);
  return askRobloxUser(cfg);
}

// ---------------------------------------------------------------
// Step 1: name the account
// ---------------------------------------------------------------
function askRobloxUser(cfg, prefill = '') {
  const input = el('input', { type: 'text', placeholder: 'e.g. lil_ghost22', value: prefill });
  const go = el('button', { class: 'btn primary', style: { width: '100%' } }, 'Continue');

  go.onclick = async () => {
    const value = input.value.trim();
    if (!value) { toast('Type your Roblox username.', 'err'); return; }
    go.disabled = true;
    go.textContent = 'Looking you up…';
    try {
      const started = await api('/appeal/verify/start', { method: 'POST', body: { robloxUser: value } });
      showVerify(cfg, started, started.target);
    } catch (err) {
      toast(msg(err), 'err');
      go.disabled = false;
      go.textContent = 'Continue';
    }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };

  card(
    signedInAs(cfg),
    heading('Which Roblox account is yours?', 'Type the username you play on, or paste your Roblox user ID.'),
    el('label', { class: 'field' }, el('span', {}, 'Roblox username or user ID'), input),
    go);
  input.focus();
}

// ---------------------------------------------------------------
// Step 2: prove it
// ---------------------------------------------------------------
function showVerify(cfg, pending, target) {
  const phrase = pending.phrase;
  const profileUrl = pending.profileUrl || `https://www.roblox.com/users/${pending.robloxId || target?.robloxId}/profile`;

  const phraseBox = el('div', { class: 'verify-phrase' }, phrase);
  const copy = el('button', {
    class: 'btn sm',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(phrase);
        copy.textContent = 'Copied';
      } catch {
        toast('Copy it by hand - the browser blocked the clipboard.', 'err');
      }
    },
  }, 'Copy');

  const check = el('button', { class: 'btn primary', style: { width: '100%' } }, 'I have added it - check now');
  check.onclick = async () => {
    check.disabled = true;
    check.textContent = 'Checking your profile…';
    try {
      const ok = await api('/appeal/verify/check', { method: 'POST', body: {} });
      toast('Roblox account verified.', 'ok');
      const status = await api('/appeal/verify/status').catch(() => ({ accounts: [] }));
      if ((status.accounts || []).length > 1) return chooseAccount(cfg, status.accounts);
      showBan(cfg, { robloxId: ok.robloxId, username: ok.username });
    } catch (err) {
      toast(msg(err), 'err');
      check.disabled = false;
      check.textContent = 'I have added it - check now';
    }
  };

  card(
    signedInAs(cfg),
    heading(
      `Prove ${target?.username || pending.username || 'that account'} is yours`,
      'This stops anyone reading somebody else’s ban. It takes about a minute and you only do it once.'
    ),
    el('ol', { class: 'verify-steps' },
      el('li', {}, 'Copy the phrase below.'),
      el('li', {}, 'Open ', el('a', { href: profileUrl, target: '_blank', rel: 'noopener' }, 'your Roblox profile'),
        ', click the pencil next to your name, and paste it into ', el('b', {}, 'About'), '.'),
      el('li', {}, 'Save, then come back and press the button.')),
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '4px 0 16px' } }, phraseBox, copy),
    check,
    el('p', { class: 'note' },
      'You can delete the phrase from your profile as soon as it is verified. ',
      pending.expiresAt ? `This one expires in ${duration(pending.expiresAt - Date.now())}.` : ''),
    el('p', { class: 'note' },
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); askRobloxUser(cfg, target?.username || ''); } },
        'Wrong account? Start again')));
}

// ---------------------------------------------------------------
// Step 2b: which of your accounts is this about?
// ---------------------------------------------------------------
function chooseAccount(cfg, accounts) {
  if (accounts.length === 1) return showBan(cfg, accounts[0]);

  const list = el('div', { class: 'account-list' });
  for (const a of accounts) {
    list.append(el('button', {
      class: 'account-row',
      onclick: () => showBan(cfg, a),
    },
      el('div', {},
        el('b', {}, a.username || a.robloxId),
        el('div', { class: 'muted', style: { fontSize: '11.5px' } },
          `verified ${timeAgo(a.verifiedAt)}`)),
      el('span', { class: 'muted' }, '→')));
  }

  card(
    signedInAs(cfg),
    heading('Which account is this about?', `You have verified ${accounts.length} Roblox accounts.`),
    list,
    el('p', { class: 'note' },
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); askRobloxUser(cfg); } },
        '+ Verify another Roblox account')));
}

// ---------------------------------------------------------------
// Step 3: the ban, the clip, and the choice
// ---------------------------------------------------------------
async function showBan(cfg, verified) {
  card(el('div', { class: 'loading' }, 'Checking your ban…'));

  let data;
  try {
    data = await api('/appeal/lookup', { method: 'POST', body: { robloxId: verified.robloxId } });
  } catch (err) {
    return card(signedInAs(cfg), el('div', { class: 'alert' }, msg(err)));
  }

  if (!data.banned) {
    return card(
      signedInAs(cfg),
      el('div', { class: 'alert alert-good' },
        el('b', {}, `${data.username || verified.username} is not banned.`), el('br'),
        'There is nothing to appeal. If you were kicked, that is not the same as a ban - just rejoin.'),
      el('p', { class: 'note' }, el('a', { href: '/' }, 'Back to Zah Hood Central')));
  }

  const b = data.ban;
  const body = el('textarea', {
    rows: 5,
    placeholder: 'Explain what happened and why the ban should be lifted. Be specific - vague appeals get denied.',
  });

  const submit = el('button', { class: 'btn primary', style: { flex: '1' } }, 'Submit appeal');
  const cancel = el('button', { class: 'btn', style: { flex: '1' } }, 'Cancel');

  submit.onclick = async () => {
    const value = body.value.trim();
    if (value.length < 20) { toast('Write at least a couple of sentences.', 'err'); return; }
    submit.disabled = true;
    submit.textContent = 'Submitting…';
    try {
      await api('/appeal/start', { method: 'POST', body: { body: value, robloxId: verified.robloxId } });
      const mine = await api('/appeal/mine');
      toast('Appeal submitted.', 'ok');
      showThread(cfg, mine.appeal);
    } catch (err) {
      toast(msg(err), 'err');
      submit.disabled = false;
      submit.textContent = 'Submit appeal';
    }
  };
  cancel.onclick = () => {
    card(
      signedInAs(cfg),
      el('div', { class: 'alert alert-good' }, 'No appeal was filed. Your ban is unchanged.'),
      el('p', { class: 'note' },
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); showBan(cfg, verified); } }, 'Changed your mind?'),
        ' · ', el('a', { href: '/' }, 'Back to Zah Hood Central')));
  };

  card(
    signedInAs(cfg),
    el('div', { class: 'ban-card' },
      el('div', { class: 'ban-head' }, el('b', {}, 'You are banned'),
        el('span', { class: 'pill err' }, b.permanent ? 'permanent' : `${duration(b.expiresAt - Date.now())} left`)),
      el('div', { class: 'ban-row' }, el('span', {}, 'Account'), el('b', {}, data.username)),
      el('div', { class: 'ban-row' }, el('span', {}, 'Reason'), el('b', {}, b.reason)),
      el('div', { class: 'ban-row' }, el('span', {}, 'Issued'), el('b', {}, dateTime(b.issuedAt))),
      el('div', { class: 'ban-row' }, el('span', {}, 'Expires'),
        el('b', {}, b.permanent ? 'Never' : dateTime(b.expiresAt)))),
    b.evidence ? evidenceBlock(b.evidence) : el('p', { class: 'note' }, 'No clip was attached to this ban.'),
    el('label', { class: 'field', style: { marginTop: '16px' } }, el('span', {}, 'Your appeal'), body),
    el('div', { style: { display: 'flex', gap: '10px' } }, cancel, submit),
    el('p', { class: 'note' },
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); askRobloxUser(cfg); } },
        'Verify another Roblox account')));
}

/** Show the clip inline when we can, and always offer the raw link. */
function evidenceBlock(url) {
  const wrap = el('div', { class: 'evidence' },
    el('div', { class: 'evidence-label' }, 'EVIDENCE'));

  const isImage = /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url);
  const isVideo = /\.(mp4|webm)(\?|$)/i.test(url);

  if (isImage) {
    wrap.append(el('img', { src: url, alt: 'Evidence', class: 'evidence-media', loading: 'lazy' }));
  } else if (isVideo) {
    wrap.append(el('video', { src: url, class: 'evidence-media', controls: true, preload: 'metadata' }));
  }

  wrap.append(el('a', { href: url, target: '_blank', rel: 'noopener', class: 'evidence-link' }, url));
  return wrap;
}

// ---------------------------------------------------------------
// Step 4: the conversation
// ---------------------------------------------------------------
function showThread(cfg, appeal) {
  const log = el('div', { class: 'appeal-log' });
  const input = el('textarea', { rows: 2, placeholder: 'Reply to staff…' });
  const send = el('button', { class: 'btn primary' }, 'Send');

  const paint = (a) => {
    clear(log);
    for (const m of a.messages) {
      if (m.from === 'system') {
        log.append(el('div', { class: 'appeal-system' }, m.body));
        continue;
      }
      log.append(el('div', { class: `appeal-msg ${m.from}` },
        el('div', { class: 'appeal-msg-head' },
          el('span', { style: m.roleColor ? { color: m.roleColor } : {} },
            m.from === 'staff' ? m.author : 'You'),
          el('span', { class: 'appeal-time' }, timeAgo(m.at))),
        el('div', { class: 'appeal-msg-body' }, m.body)));
    }
    log.scrollTop = log.scrollHeight;
  };

  send.onclick = async () => {
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    try {
      await api('/appeal/mine/message', { method: 'POST', body: { body: value } });
      const fresh = await api('/appeal/mine');
      paint(fresh.appeal);
    } catch (err) {
      toast(msg(err), 'err');
      input.value = value;
    }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } };

  const statusPill =
    appeal.status === 'pending' && !appeal.claimed ? el('span', { class: 'pill warnp' }, 'waiting to be claimed')
      : appeal.status === 'pending' ? el('span', { class: 'pill info' }, `claimed by a ${appeal.claimedByRole || 'moderator'}`)
      : appeal.status === 'accepted' ? el('span', { class: 'pill ok' }, 'accepted')
      : appeal.status === 'withdrawn' ? el('span', { class: 'pill mute' }, 'withdrawn')
      : el('span', { class: 'pill err' }, 'denied');

  const open = appeal.status === 'pending';
  const canSpeak = open && appeal.claimed;

  card(
    signedInAs(cfg),
    el('div', { class: 'appeal-head' },
      el('div', {}, el('b', {}, `Appeal #${appeal.id}`),
        el('div', { class: 'muted', style: { fontSize: '12px' } }, `Filed ${timeAgo(appeal.createdAt)}`)),
      statusPill),
    appeal.ban
      ? el('div', { class: 'appeal-ban-note' }, el('b', {}, 'Ban: '), appeal.ban.reason)
      : null,
    log,
    open && !appeal.claimed
      ? el('div', { class: 'appeal-waiting' },
          el('b', {}, appeal.awaitingDetails
            ? 'This ban has no reason or clip recorded yet.'
            : 'Waiting for a moderator to claim this ticket.'),
          el('div', { style: { marginTop: '5px' } },
            appeal.awaitingDetails
              ? 'A moderator has to look into it before anyone can explain it to you. You will be able to reply once somebody claims the ticket.'
              : 'You will be able to reply as soon as somebody picks it up. There is nothing else you need to do.'))
      : null,
    canSpeak
      ? el('div', { class: 'appeal-compose' },
          el('div', { style: { display: 'flex', gap: '8px' } }, input, send),
          el('div', { class: 'note', style: { marginTop: '8px', display: 'flex', justifyContent: 'space-between' } },
            el('span', {}, 'Staff reply here. You will see it when you come back.'),
            el('a', { href: '#', onclick: (e) => { e.preventDefault(); withdraw(cfg); } }, 'Withdraw appeal')))
      : open
        ? el('p', { class: 'note' },
            el('a', { href: '#', onclick: (e) => { e.preventDefault(); withdraw(cfg); } }, 'Withdraw appeal'))
      : el('p', { class: 'note' },
          'This appeal is closed. ', el('a', { href: '/' }, 'Back to Zah Hood Central')));

  paint(appeal);

  // Poll for staff replies while the appeal is open.
  if (open) {
    const timer = setInterval(async () => {
      try {
        const fresh = await api('/appeal/mine');
        if (!fresh.appeal || fresh.appeal.status !== 'pending') {
          clearInterval(timer);
          return showThread(cfg, fresh.appeal);
        }
        if (fresh.appeal.messages.length !== log.childElementCount) paint(fresh.appeal);
      } catch { /* keep what is on screen */ }
    }, 10_000);
  }
}

async function withdraw(cfg) {
  if (!confirm('Withdraw this appeal? Staff will stop looking at it and your ban stays as it is.')) return;
  try {
    await api('/appeal/mine/cancel', { method: 'POST', body: {} });
    const mine = await api('/appeal/mine');
    toast('Appeal withdrawn.', '');
    showThread(cfg, mine.appeal);
  } catch (err) { toast(msg(err), 'err'); }
}

boot().catch((err) => {
  card(el('div', { class: 'alert' }, msg(err)));
});

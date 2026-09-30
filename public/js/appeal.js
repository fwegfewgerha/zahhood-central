// Appeal page logic.
// A separate file because the Content-Security-Policy is `script-src 'self'`,
// which blocks inline scripts on purpose.

import { el, clear, api, toast, errMessage, dateTime, timeAgo } from '/js/core.js';

const content = document.getElementById('content');

async function load() {
  let me;
  try {
    me = await api('/me');
  } catch {
    location.href = '/auth/discord?next=/appeal';
    return;
  }

  let status;
  try {
    status = await fetch('/api/appeal/status', { credentials: 'same-origin' }).then((r) => r.json());
  } catch (err) {
    clear(content).append(el('div', { class: 'alert' }, 'Could not load your appeal status.'));
    return;
  }

  clear(content);

  const header = el('p', { class: 'note', style: { textAlign: 'center', marginTop: 0 } },
    'Signed in as ', el('b', {}, me.user.username), ' · ', el('a', { href: '/auth/logout' }, 'Sign out'));
  content.append(header);

  if (!status.linked) {
    content.append(linkForm());
    return;
  }

  if (status.appeals?.length) {
    for (const a of status.appeals.slice(0, 3)) {
      content.append(el('div', {
        class: 'feature',
        style: { marginBottom: '10px' },
      },
        el('b', {}, `Appeal #${a.id} — ${a.status}`),
        el('span', {}, `Filed ${timeAgo(a.createdAt)}`),
        a.response ? el('span', { style: { display: 'block', marginTop: '6px', color: 'var(--text-dim)' } }, `Staff said: ${a.response}`) : null));
    }
  }

  if (!status.banned) {
    content.append(el('div', {
      class: 'alert',
      style: { background: 'rgba(61,220,132,.1)', borderColor: 'rgba(61,220,132,.35)', color: '#9ff0c2' },
    }, 'Your linked Roblox account is not banned right now, so there is nothing to appeal.'));
    content.append(el('p', { class: 'note' }, el('a', { href: '/' }, 'Back to Zah Hood Central')));
    return;
  }

  const pending = status.appeals?.find((a) => a.status === 'pending');
  if (pending) {
    content.append(el('div', { class: 'alert', style: { background: 'rgba(255,200,87,.1)', borderColor: 'rgba(255,200,87,.35)', color: '#ffe0a0' } },
      'You already have an appeal waiting on a decision. Staff will get to it.'));
    return;
  }

  content.append(
    el('div', { class: 'alert' },
      el('b', {}, 'You are banned.'), el('br'),
      status.ban.reason, el('br'),
      el('span', { style: { opacity: .8 } },
        status.ban.expiresAt ? `Expires ${dateTime(status.ban.expiresAt)}` : 'This ban is permanent.'))
  );

  const body = el('textarea', {
    rows: 6,
    placeholder: 'Explain what happened and why the ban should be lifted. Be specific - vague appeals get denied.',
  });

  content.append(
    el('label', { class: 'field' }, el('span', {}, 'Your appeal'), body),
    el('button', {
      class: 'btn primary',
      style: { width: '100%' },
      onclick: async (e) => {
        const value = body.value.trim();
        if (value.length < 20) { toast('Write at least a couple of sentences.', 'err'); return; }
        e.target.disabled = true;
        try {
          await api('/appeal', { method: 'POST', body: { body: value } });
          toast('Appeal submitted.', 'ok');
          load();
        } catch (err) {
          toast(errMessage(err), 'err');
          e.target.disabled = false;
        }
      },
    }, 'Submit appeal')
  );
}

function linkForm() {
  const idInput = el('input', { type: 'text', placeholder: 'e.g. 1234567' });
  const nameInput = el('input', { type: 'text', placeholder: 'Your Roblox username' });

  return el('div', {},
    el('p', { class: 'note', style: { textAlign: 'left' } },
      'Tell us which Roblox account was banned so we can find the punishment.'),
    el('label', { class: 'field' }, el('span', {}, 'Roblox user ID'), idInput),
    el('label', { class: 'field' }, el('span', {}, 'Roblox username'), nameInput),
    el('button', {
      class: 'btn primary',
      style: { width: '100%' },
      onclick: async (e) => {
        const id = parseInt(idInput.value.trim(), 10);
        if (!Number.isFinite(id) || id <= 0) { toast('Enter your numeric Roblox user ID.', 'err'); return; }
        e.target.disabled = true;
        try {
          await api('/me/roblox', { method: 'POST', body: { robloxId: id, username: nameInput.value.trim() } });
          load();
        } catch (err) {
          toast(errMessage(err), 'err');
          e.target.disabled = false;
        }
      },
    }, 'Link account'),
    el('p', { class: 'note' },
      'Find your ID in the URL of your Roblox profile: roblox.com/users/', el('b', {}, '1234567'), '/profile'));
}

load();

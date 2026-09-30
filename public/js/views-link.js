// ============================================================
// First-run Roblox verification for staff.
// Shown instead of the panel until they have proved an account.
// ============================================================
import { el, clear, api, toast, errMessage, duration } from './core.js';

const ERRORS = {
  roblox_user_not_found: 'No Roblox account with that name. Check the spelling, or paste your user ID instead.',
  roblox_already_claimed: 'Another account on this site has already verified that Roblox user.',
  description_empty: 'Your Roblox About section is empty. Paste the phrase in, save, then try again.',
  phrase_not_found: 'The phrase is not in your About section yet. Roblox can take a moment to save - wait a few seconds and try again.',
  roblox_unreachable: 'Roblox is not responding right now. Try again in a minute.',
  no_pending_verification: 'That verification expired. Start again.',
};
const msg = (e) => ERRORS[e?.message] || errMessage(e);

/**
 * @param {HTMLElement} root  where to draw
 * @param {object} me         the signed-in user
 * @param {Function} onDone   called once an account is proved
 */
export async function robloxLinkScreen(root, me, onDone) {
  const status = await api('/link/status').catch(() => ({}));
  if (status.pending) return showPhrase(status.pending, null);
  return askUsername();

  function shell(...kids) {
    clear(root).append(
      el('main', { class: 'landing' },
        el('div', { class: 'landing-card', style: { textAlign: 'left' } },
          el('div', { style: { textAlign: 'center' } },
            el('div', { class: 'brand-mark' }, el('span', { class: 'glyph' }, 'ZH')),
            el('h1', { style: { fontSize: '22px' } }, 'One more step'),
            el('p', { class: 'note', style: { marginTop: 0 } },
              'Signed in as ', el('b', {}, me.username), ' · ',
              el('a', { href: '/auth/logout' }, 'Sign out'))),
          ...kids)));
  }

  function askUsername(prefill = '') {
    const input = el('input', { type: 'text', placeholder: 'e.g. lil_ghost22', value: prefill });
    const go = el('button', { class: 'btn primary', style: { width: '100%' } }, 'Continue');

    go.onclick = async () => {
      const value = input.value.trim();
      if (!value) { toast('Type your Roblox username.', 'err'); return; }
      go.disabled = true;
      go.textContent = 'Looking you up…';
      try {
        const started = await api('/link/start', { method: 'POST', body: { robloxUser: value } });
        showPhrase(started, started.target);
      } catch (err) {
        toast(msg(err), 'err');
        go.disabled = false;
        go.textContent = 'Continue';
      }
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };

    shell(
      el('div', { style: { marginBottom: '16px' } },
        el('div', { style: { fontSize: '14px', fontWeight: 650, marginBottom: '6px' } },
          'Link your Roblox account'),
        el('div', { class: 'muted', style: { fontSize: '12.5px' } },
          'Staff prove which Roblox account is theirs, so every punishment traces back to a person rather than a Discord name. You only do this once.')),
      el('label', { class: 'field' }, el('span', {}, 'Roblox username or user ID'), input),
      go);
    input.focus();
  }

  function showPhrase(pending, target) {
    const phrase = pending.phrase;
    const profileUrl = pending.profileUrl
      || `https://www.roblox.com/users/${pending.robloxId || target?.robloxId}/profile`;

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
        const ok = await api('/link/check', { method: 'POST', body: {} });
        toast(`Verified as ${ok.username}.`, 'ok');
        onDone();
      } catch (err) {
        toast(msg(err), 'err');
        check.disabled = false;
        check.textContent = 'I have added it - check now';
      }
    };

    shell(
      el('div', { style: { marginBottom: '14px' } },
        el('div', { style: { fontSize: '14px', fontWeight: 650, marginBottom: '6px' } },
          `Prove ${target?.username || 'that account'} is yours`),
        el('div', { class: 'muted', style: { fontSize: '12.5px' } },
          'Only the account holder can edit a Roblox profile, which is what makes this proof.')),
      el('ol', { class: 'verify-steps' },
        el('li', {}, 'Copy the phrase below.'),
        el('li', {}, 'Open ', el('a', { href: profileUrl, target: '_blank', rel: 'noopener' }, 'your Roblox profile'),
          ', click the pencil next to your name, and paste it into ', el('b', {}, 'About'), '.'),
        el('li', {}, 'Save, then come back and press the button.')),
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '4px 0 16px' } },
        el('div', { class: 'verify-phrase' }, phrase), copy),
      check,
      el('p', { class: 'note' },
        'You can delete the phrase as soon as it is verified. ',
        pending.expiresAt ? `This one expires in ${duration(pending.expiresAt - Date.now())}.` : ''),
      el('p', { class: 'note' },
        el('a', {
          href: '#',
          onclick: (e) => { e.preventDefault(); askUsername(target?.username || ''); },
        }, 'Wrong account? Start again')));
  }
}

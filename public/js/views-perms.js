// ============================================================
// Permission editor - Game Owner only.
// A grid of toggles: one row per permission, one column per rank.
// ============================================================
import {
  state, el, clear, api, toast, errMessage, modal, confirmDialog,
} from './core.js';

export async function permissionsView(view) {
  let matrix = await api('/permissions');
  let focusRole = sessionStorage.getItem('zhc.permRole') || null;

  // The ladder reads top-down in the UI, highest rank first.
  const ranked = () => [...matrix.roles].sort((a, b) => b.rank - a.rank);

  const render = () => {
    const roles = ranked();
    const shown = focusRole ? roles.filter((r) => r.key === focusRole) : roles;

    clear(view).append(
      toolbar(roles),
      el('div', { style: { height: '14px' } }),
      ...matrix.categories
        .map((cat) => categoryCard(cat, shown))
        .filter(Boolean),
      el('div', { style: { height: '14px' } }),
      footerNote()
    );
  };

  // ---------------- toolbar ----------------
  function toolbar(roles) {
    const select = el('select', {
      style: { maxWidth: '240px' },
      onchange: (e) => {
        focusRole = e.target.value || null;
        if (focusRole) sessionStorage.setItem('zhc.permRole', focusRole);
        else sessionStorage.removeItem('zhc.permRole');
        render();
      },
    },
      el('option', { value: '' }, 'All ranks side by side'),
      ...roles.map((r) => el('option', { value: r.key }, `${r.name} (rank ${r.rank})`)));
    select.value = focusRole || '';

    const changed = countOverrides();

    return el('div', { class: 'toolbar' },
      select,
      changed
        ? el('span', { class: 'pill warnp' }, `${changed} change${changed === 1 ? '' : 's'} from default`)
        : el('span', { class: 'pill mute' }, 'all defaults'),
      el('div', { style: { marginLeft: 'auto' }, class: 'btn-row' },
        changed
          ? el('button', { class: 'btn sm', onclick: resetAll }, 'Reset everything to default')
          : null));
  }

  function countOverrides() {
    let n = 0;
    for (const p of matrix.permissions) {
      for (const g of Object.values(p.grants)) if (g.overridden) n++;
    }
    return n;
  }

  // ---------------- one category ----------------
  function categoryCard(category, roles) {
    const rows = matrix.permissions.filter((p) => p.category === category);
    if (!rows.length) return null;

    const table = el('table');
    table.append(
      el('thead', {}, el('tr', {},
        el('th', { style: { minWidth: '230px' } }, 'Can they…'),
        ...roles.map((r) =>
          el('th', {
            style: { textAlign: 'center', minWidth: '78px', color: r.color },
            title: `${r.name} · rank ${r.rank}`,
          }, shortName(r.name)))))
    );

    const tbody = el('tbody');
    for (const perm of rows) {
      tbody.append(el('tr', {},
        el('td', {},
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
            el('b', { style: { fontWeight: 600 } }, perm.label),
            perm.danger ? el('span', { class: 'pill err', title: 'Sensitive' }, '!') : null,
            perm.locked ? el('span', { class: 'pill mute' }, 'locked') : null),
          perm.desc
            ? el('div', { class: 'muted', style: { fontSize: '11.5px', maxWidth: '380px' } }, perm.desc)
            : null),
        ...roles.map((r) => el('td', { style: { textAlign: 'center' } }, toggle(perm, r)))));
    }
    table.append(tbody);

    return el('div', { class: 'card', style: { marginBottom: '14px', overflowX: 'auto' } },
      el('div', { class: 'card-head' }, el('h3', {}, category)),
      table);
  }

  // ---------------- a single cell ----------------
  function toggle(perm, role) {
    const grant = perm.grants[role.key];
    const locked = perm.locked;

    const btn = el('button', {
      class: 'perm-toggle',
      title: locked
        ? 'Locked to the Game Owner and not editable'
        : grant.overridden
          ? `Changed from the default (${grant.byDefault ? 'was on' : 'was off'})`
          : 'Default',
      disabled: locked,
      dataset: { on: grant.allowed ? '1' : '0', overridden: grant.overridden ? '1' : '0' },
      onclick: () => flip(perm, role, !grant.allowed),
    }, grant.allowed ? '✓' : '—');

    return btn;
  }

  async function flip(perm, role, next) {
    // Warn before handing a sensitive power to a junior rank.
    if (next && perm.danger && role.rank < (perm.defaultRank ?? 100)) {
      const ok = await confirmDialog(
        `Give ${role.name} this?`,
        `"${perm.label}" is normally reserved for rank ${perm.defaultRank} and above. ` +
        `${role.name} is rank ${role.rank}. ${perm.desc || ''}`.trim(),
        `Yes, give it to ${role.name}`
      );
      if (!ok) return;
    }

    try {
      const res = await api('/permissions', {
        method: 'POST',
        body: { role: role.key, permission: perm.key, allowed: next },
      });
      matrix = res.matrix;
      render();
      toast(`${role.name}: ${perm.label} ${next ? 'enabled' : 'disabled'}.`, next ? 'ok' : '');
      if (role.key === state.me.role) await refreshMe();
    } catch (err) {
      toast(errMessage(err), 'err');
    }
  }

  async function resetAll() {
    const ok = await confirmDialog(
      'Reset all permissions',
      `Every rank goes back to what it shipped with. ${countOverrides()} change${countOverrides() === 1 ? '' : 's'} will be undone.`,
      'Reset everything'
    );
    if (!ok) return;
    try {
      const res = await api('/permissions', { method: 'DELETE' });
      matrix = res.matrix;
      render();
      toast('Permissions reset to defaults.', 'ok');
      await refreshMe();
    } catch (err) { toast(errMessage(err), 'err'); }
  }

  /** Your own sidebar depends on your permissions, so re-read them. */
  async function refreshMe() {
    try {
      const me = await api('/me');
      state.me = me.user;
    } catch { /* not fatal */ }
  }

  function footerNote() {
    return el('div', { class: 'card' },
      el('div', { class: 'card-body' },
        el('div', { style: { fontSize: '13px', marginBottom: '10px' } },
          el('b', {}, 'What these toggles cannot do')),
        el('ul', { class: 'muted', style: { fontSize: '12.5px', margin: 0, paddingLeft: '18px', lineHeight: '1.9' } },
          el('li', {}, 'Rank order never changes. A higher rank still always outranks a lower one.'),
          el('li', {}, 'Promoting is still capped at ranks strictly below your own, even with ',
            el('b', {}, '"Promote and demote"'), ' switched on. A Chat Moderator given it could only ever appoint Members.'),
          el('li', {}, 'Lifting punishments and deleting chat still only work on ranks below the actor.'),
          el('li', {}, 'Chat rooms keep their own rank gate on top of ', el('b', {}, '"Read staff chat"'), '.'),
          el('li', {}, 'Game Owner cannot be granted by anyone, through any toggle. It comes from the server environment file alone.'),
          el('li', {}, 'The two Owner-only rows are locked deliberately — a rank able to edit this table could grant itself everything else.'))));
  }

  render();
}

function shortName(name) {
  return name
    .replace('Administrator', 'Admin')
    .replace('Moderator', 'Mod')
    .replace('Community Manager', 'Comm Mgr')
    .replace('Owner Assistant', 'Owner Asst');
}

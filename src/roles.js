// ---------------------------------------------------------------
// Staff ladder for Zah Hood Central.
// `rank` is the only thing that matters for comparisons - a higher
// rank can always act on a lower one, never on an equal or higher one.
//
// The Game Owner can rename these and recolour them from the panel.
// `key`, `rank` and `staff` are structural and deliberately NOT editable:
// renaming is cosmetic and can never reshuffle who outranks whom.
// ---------------------------------------------------------------
import { db } from './db.js';

const BASE_ROLES = [
  { key: 'member',            name: 'Member',                 rank: 0,   color: '#8b93a7', staff: false },
  { key: 'chat_mod',          name: 'Chat Moderator',         rank: 10,  color: '#5fb87a', staff: true },
  { key: 'trial_mod',         name: 'Trial Moderator',        rank: 15,  color: '#54c08c', staff: true },
  { key: 'moderator',         name: 'Moderator',              rank: 20,  color: '#3fb5c9', staff: true },
  { key: 'senior_mod',        name: 'Senior Moderator',       rank: 30,  color: '#3d8fe0', staff: true },
  { key: 'head_mod',          name: 'Head Moderator',         rank: 40,  color: '#6a6ae8', staff: true },
  { key: 'admin',             name: 'Administrator',          rank: 50,  color: '#9b59f0', staff: true },
  { key: 'senior_admin',      name: 'Senior Administrator',   rank: 55,  color: '#c355e6', staff: true },
  { key: 'head_admin',        name: 'Head Administrator',     rank: 60,  color: '#e05ac0', staff: true },
  { key: 'community_manager', name: 'Community Manager',      rank: 65,  color: '#ef5b8c', staff: true },
  { key: 'owner_assistant',   name: 'Owner Assistant',        rank: 70,  color: '#f2724b', staff: true },
  // --- the only three above Owner Assistant ---
  { key: 'co_owner',          name: 'Co-Owner',               rank: 80,  color: '#ffa32e', staff: true },
  { key: 'creator',           name: 'Creator',                rank: 90,  color: '#ffd447', staff: true },
  { key: 'game_owner',        name: 'Game Owner',             rank: 100, color: '#ff4d4d', staff: true },
  // --- website owner, above everything ---
  { key: 'gin',               name: 'Gin',                    rank: 110, color: '#ffffff', staff: true },
];

/**
 * Ranks that exist outside the editable ladder. They are granted by the
 * server environment file alone, never appear as something to assign, and
 * are left out of the permission editor entirely.
 */
export const PROTECTED_ROLES = new Set(['gin', 'game_owner']);

export const DEFAULT_ROLE = 'member';
export const ROLE_KEYS = BASE_ROLES.map((r) => r.key);

/** The unchangeable ladder, for anything that must ignore renames. */
export const BASE_ROLE_MAP = Object.fromEntries(BASE_ROLES.map((r) => [r.key, r]));

let overrideCache = null;

function overrides() {
  if (overrideCache) return overrideCache;
  overrideCache = {};
  try {
    for (const row of db.prepare('SELECT role_key, name, color FROM role_overrides').all()) {
      overrideCache[row.role_key] = row;
    }
  } catch {
    // Table not created yet (first boot) - fall back to the defaults.
  }
  return overrideCache;
}

/** Call after any write to role_overrides so the next read picks it up. */
export function refreshRoles() {
  overrideCache = null;
}

function applyOverride(base) {
  const o = overrides()[base.key];
  if (!o) return base;
  return {
    ...base,
    name: o.name || base.name,
    color: o.color || base.color,
    renamed: !!(o.name && o.name !== base.name),
    defaultName: base.name,
  };
}

/** The ladder as it should be displayed right now. */
export function allRoles() {
  return BASE_ROLES.map(applyOverride);
}

export function role(key) {
  const base = BASE_ROLE_MAP[key] || BASE_ROLE_MAP[DEFAULT_ROLE];
  return applyOverride(base);
}

/** Rename / recolour a role. Only the display side can ever change. */
export function setRoleAppearance(key, { name, color }, actor) {
  if (!BASE_ROLE_MAP[key]) return { error: 'unknown_role' };
  const clean = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const newName = clean(name, 40);
  const newColor = clean(color, 9);
  if (newColor && !/^#[0-9a-fA-F]{6}$/.test(newColor)) return { error: 'bad_color' };

  db.prepare(
    `INSERT INTO role_overrides (role_key, name, color, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(role_key) DO UPDATE SET
       name = excluded.name, color = excluded.color,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(key, newName, newColor, actor?.discord_username ?? 'system', Date.now());

  refreshRoles();
  return { role: role(key) };
}

/** Drop a rename and go back to the shipped name/colour. */
export function resetRoleAppearance(key) {
  if (!BASE_ROLE_MAP[key]) return { error: 'unknown_role' };
  db.prepare('DELETE FROM role_overrides WHERE role_key = ?').run(key);
  refreshRoles();
  return { role: role(key) };
}

export function rankOf(key) {
  return role(key).rank;
}

export function isStaff(key) {
  return role(key).staff === true;
}

// ---------------------------------------------------------------
// Permissions. Each entry is the minimum rank that unlocks it.
// ---------------------------------------------------------------
export const PERMISSIONS = {
  'panel.access':      10,  // see anything past the landing page
  'db.view':           10,  // browse the player database
  'db.note':           10,  // leave notes on a player
  'servers.view':      10,  // live server browser + who is in a server
  'stats.view':        10,  // live stats dashboard
  'chat.read':         10,  // staff chat
  'chat.write':        10,
  'punish.warn':       10,
  'punish.kick':       20,
  'punish.mute':       10,
  'punish.ban.temp':   30,
  'punish.ban.perm':   40,
  'punish.revoke':     30,  // ...and only over punishments issued by a lower rank
  'punish.viewAll':    20,  // see punishments issued by every staff member
  'chat.delete':       40,
  'servers.shutdown':  60,
  'audit.view':        40,
  'appeals.review':    30,  // accept or deny
  'appeals.chat':      20,  // read and reply in the appeal conversation
  'staff.view':        10,
  'chatmod.view':      10,  // the chat moderation section
  'chatmod.mute':      10,  // time someone out in the Discord server
  'chatmod.unmute':    10,  // lift a mute (only one from a lower rank)
  'chatmod.evidence':  10,  // view the screenshot behind a mute
  'staff.manage':      70,  // promote / demote, always strictly below your own rank
  'staff.remove':      70,
  'apikeys.view':      70,
  'apikeys.manage':    80,  // create/revoke the keys the game uses
  'settings.manage':   80,
  'db.purge':          90,
  'whitelist.view':    70,  // see who is allowed to sign in
  'whitelist.manage':  80,  // add / remove people from the whitelist
  'security.view':     70,  // rejected logins, active sessions
  'roles.rename':     100,  // Game Owner only: rename and recolour the ladder
  'roles.permissions':100,  // Game Owner only: edit this very table
  'traffic.view':     110,  // Gin only: who is on the website right now
};

/**
 * These can never be handed to a lower rank, and the permission editor
 * refuses to touch them. Both are "meta" powers: anything able to rewrite
 * the permission table could grant itself everything else, so they stay
 * pinned to the Game Owner no matter what the override table says.
 */
export const LOCKED_PERMISSIONS = new Set(['roles.permissions', 'roles.rename', 'traffic.view']);

/** Labels and descriptions for the permission editor. */
export const PERMISSION_META = {
  'panel.access':      { category: 'Access', label: 'Open the staff panel', desc: 'Without this the account only ever sees the landing page.' },
  'stats.view':        { category: 'Access', label: 'See the live dashboard', desc: 'Player counts, servers, graphs and the activity feed.' },
  'servers.view':      { category: 'Access', label: 'Browse live servers', desc: 'The server list and the who-is-in-this-server lookup.' },
  'staff.view':        { category: 'Access', label: 'See the staff team', desc: 'Who is on the team and what rank they hold.' },

  'db.view':           { category: 'Player database', label: 'Search the database', desc: 'Look up any player, their stats and their history.' },
  'db.note':           { category: 'Player database', label: 'Leave staff notes', desc: 'Write notes on a player for the rest of the team.' },
  'db.purge':          { category: 'Player database', label: 'Purge player data', desc: 'Permanently delete records.', danger: true },

  'punish.warn':       { category: 'Moderation', label: 'Issue warnings' },
  'punish.mute':       { category: 'Moderation', label: 'Mute players', desc: 'Blocks them from in-game chat.' },
  'punish.kick':       { category: 'Moderation', label: 'Kick players', desc: 'Boots them out of the server they are in.' },
  'punish.ban.temp':   { category: 'Moderation', label: 'Issue temporary bans', desc: 'Bans that carry an expiry date.' },
  'punish.ban.perm':   { category: 'Moderation', label: 'Issue permanent bans', desc: 'Bans that never expire.', danger: true },
  'punish.revoke':     { category: 'Moderation', label: 'Lift punishments', desc: 'Still only ones issued by a rank below their own.' },
  'punish.viewAll':    { category: 'Moderation', label: 'See all casework', desc: 'Without this they only see punishments they issued themselves.' },
  'appeals.review':    { category: 'Moderation', label: 'Rule on ban appeals', desc: 'Accept or deny appeals from banned players.' },
  'appeals.chat':      { category: 'Moderation', label: 'Talk to appellants', desc: 'Read and reply in the appeal conversation. Moderator and above by default.' },

  'chat.read':         { category: 'Staff chat', label: 'Read staff chat', desc: 'Individual rooms are still gated by rank on top of this.' },
  'chat.write':        { category: 'Staff chat', label: 'Post in staff chat' },
  'chat.delete':       { category: 'Staff chat', label: 'Delete messages', desc: 'Still only messages from ranks below their own.' },

  'chatmod.view':      { category: 'Chat moderation', label: 'Open chat moderation', desc: 'The Discord mute tools. Chat Moderator is the lowest rank that has this by default.' },
  'chatmod.mute':      { category: 'Chat moderation', label: 'Mute in Discord', desc: 'Times the person out in your Discord server. Discord never shows who ordered it.' },
  'chatmod.unmute':    { category: 'Chat moderation', label: 'Lift a Discord mute', desc: 'Still only mutes issued by a rank below their own.' },
  'chatmod.evidence':  { category: 'Chat moderation', label: 'View mute screenshots', desc: 'Open the screenshot attached to a mute.' },

  'servers.shutdown':  { category: 'Servers', label: 'Shut down a server', desc: 'Disconnects everyone inside it.', danger: true },

  'staff.manage':      { category: 'Team', label: 'Promote and demote', desc: 'Always limited to ranks strictly below their own.', danger: true },
  'staff.remove':      { category: 'Team', label: 'Suspend staff accounts', desc: 'Also allows signing someone out of every device.', danger: true },

  'whitelist.view':    { category: 'Administration', label: 'See the whitelist' },
  'whitelist.manage':  { category: 'Administration', label: 'Edit the whitelist', desc: 'Decide who may sign in to this site at all.', danger: true },
  'security.view':     { category: 'Administration', label: 'See security activity', desc: 'Rejected sign-ins and active sessions.' },
  'audit.view':        { category: 'Administration', label: 'Read the audit log', desc: 'Every staff action ever taken.' },
  'apikeys.view':      { category: 'Administration', label: 'See game API keys' },
  'apikeys.manage':    { category: 'Administration', label: 'Create and revoke keys', desc: 'A key lets a Roblox server read and write your database.', danger: true },
  'settings.manage':   { category: 'Administration', label: 'Change site settings', desc: 'Includes turning the whitelist on and off.', danger: true },

  'roles.rename':      { category: 'Owner only', label: 'Rename ranks', desc: 'Pinned to the Game Owner and not editable.' },
  'roles.permissions': { category: 'Owner only', label: 'Edit this permission table', desc: 'Pinned to the Game Owner and not editable - anything able to rewrite permissions could grant itself everything else.' },
  'traffic.view':      { category: 'Owner only', label: 'See website traffic', desc: 'Website owner only. Not grantable.' },
};

export const PERMISSION_CATEGORIES = [
  'Access', 'Player database', 'Moderation', 'Chat moderation', 'Staff chat', 'Servers', 'Team', 'Administration', 'Owner only',
];

// ---------------------------------------------------------------
// Per-rank permission overrides, set by the Game Owner.
// A row here beats the default threshold above.
// ---------------------------------------------------------------
let permCache = null;

function permOverrides() {
  if (permCache) return permCache;
  permCache = {};
  try {
    for (const row of db.prepare('SELECT role_key, permission, allowed FROM role_permissions').all()) {
      (permCache[row.role_key] ||= {})[row.permission] = row.allowed;
    }
  } catch {
    // Table does not exist yet on a first boot.
  }
  return permCache;
}

export function refreshPermissions() {
  permCache = null;
}

export function can(roleKey, permission) {
  const need = PERMISSIONS[permission];
  if (need === undefined) return false;

  // Meta powers ignore the override table entirely.
  if (LOCKED_PERMISSIONS.has(permission)) return rankOf(roleKey) >= need;

  const override = permOverrides()[roleKey]?.[permission];
  if (override !== undefined) return override === 1;
  return rankOf(roleKey) >= need;
}

/** True when this permission is on for this rank with no override applied. */
export function defaultAllows(roleKey, permission) {
  const need = PERMISSIONS[permission];
  if (need === undefined) return false;
  return rankOf(roleKey) >= need;
}

/** Turn one permission on or off for one rank. */
export function setRolePermission(roleKey, permission, allowed, actor) {
  if (!BASE_ROLE_MAP[roleKey]) return { error: 'unknown_role' };
  if (roleKey === 'gin') return { error: 'role_not_editable' };
  if (PERMISSIONS[permission] === undefined) return { error: 'unknown_permission' };
  if (LOCKED_PERMISSIONS.has(permission)) return { error: 'permission_locked' };

  db.prepare(
    `INSERT INTO role_permissions (role_key, permission, allowed, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(role_key, permission) DO UPDATE SET
       allowed = excluded.allowed, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(roleKey, permission, allowed ? 1 : 0, actor?.discord_username ?? 'system', Date.now());

  refreshPermissions();
  return { ok: true };
}

/** Send a rank, or the whole table, back to the shipped defaults. */
export function resetRolePermissions(roleKey) {
  if (roleKey) db.prepare('DELETE FROM role_permissions WHERE role_key = ?').run(roleKey);
  else db.prepare('DELETE FROM role_permissions').run();
  refreshPermissions();
  return { ok: true };
}

/** The whole grid, shaped for the editor. */
export function permissionMatrix() {
  const ov = permOverrides();
  // Gin is the website owner's own rank: it holds everything by definition
  // and is deliberately absent from the grid.
  const editableRoles = ROLE_KEYS.filter((k) => k !== 'gin');
  return {
    categories: PERMISSION_CATEGORIES,
    roles: publicRoleList().filter((r) => r.key !== 'gin'),
    permissions: Object.keys(PERMISSIONS).map((key) => {
      const meta = PERMISSION_META[key] || {};
      const locked = LOCKED_PERMISSIONS.has(key);
      return {
        key,
        label: meta.label || key,
        desc: meta.desc || null,
        category: meta.category || 'Administration',
        danger: !!meta.danger,
        locked,
        defaultRank: PERMISSIONS[key],
        grants: Object.fromEntries(
          editableRoles.map((roleKey) => {
            const override = ov[roleKey]?.[key];
            const byDefault = defaultAllows(roleKey, key);
            const allowed = locked || override === undefined ? byDefault : override === 1;
            return [roleKey, { allowed, byDefault, overridden: allowed !== byDefault }];
          })
        ),
      };
    }),
  };
}

/** Everything this role may do, as a flat list - handy for the client. */
export function permissionsFor(roleKey) {
  return Object.keys(PERMISSIONS).filter((key) => can(roleKey, key));
}

/** Roles `roleKey` is allowed to hand out (always strictly below itself). */
export function assignableRoles(roleKey) {
  const r = rankOf(roleKey);
  return BASE_ROLES.filter((x) => x.rank < r && !PROTECTED_ROLES.has(x.key)).map((x) => x.key);
}

/** True when `actor` outranks `target` and may therefore act on them. */
export function outranks(actorRole, targetRole) {
  return rankOf(actorRole) > rankOf(targetRole);
}

export function publicRoleList() {
  return allRoles().map(({ key, name, rank, color, staff, renamed, defaultName }) => ({
    key, name, rank, color, staff, renamed: !!renamed, defaultName: defaultName || name,
  }));
}

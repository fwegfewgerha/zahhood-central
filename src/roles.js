// ---------------------------------------------------------------
// Staff ladder for Zah Hood Central.
// `rank` is the only thing that matters for comparisons - a higher
// rank can always act on a lower one, never on an equal or higher one.
// ---------------------------------------------------------------

export const ROLES = [
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
];

export const ROLE_MAP = Object.fromEntries(ROLES.map((r) => [r.key, r]));
export const DEFAULT_ROLE = 'member';

export function role(key) {
  return ROLE_MAP[key] || ROLE_MAP[DEFAULT_ROLE];
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
  'appeals.review':    30,
  'staff.view':        10,
  'staff.manage':      70,  // promote / demote, always strictly below your own rank
  'staff.remove':      70,
  'apikeys.view':      70,
  'apikeys.manage':    80,  // create/revoke the keys the game uses
  'settings.manage':   80,
  'db.purge':          90,
};

export function can(roleKey, permission) {
  const need = PERMISSIONS[permission];
  if (need === undefined) return false;
  return rankOf(roleKey) >= need;
}

/** Everything this role may do, as a flat list - handy for the client. */
export function permissionsFor(roleKey) {
  const r = rankOf(roleKey);
  return Object.entries(PERMISSIONS)
    .filter(([, need]) => r >= need)
    .map(([key]) => key);
}

/** Roles `roleKey` is allowed to hand out (always strictly below itself). */
export function assignableRoles(roleKey) {
  const r = rankOf(roleKey);
  return ROLES.filter((x) => x.rank < r).map((x) => x.key);
}

/** True when `actor` outranks `target` and may therefore act on them. */
export function outranks(actorRole, targetRole) {
  return rankOf(actorRole) > rankOf(targetRole);
}

export function publicRoleList() {
  return ROLES.map(({ key, name, rank, color, staff }) => ({ key, name, rank, color, staff }));
}

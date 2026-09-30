/**
 * End-to-end smoke test against a running server.
 *
 *   node src/server.js            # in one terminal
 *   node scripts/smoke-test.js    # in another
 *
 * Walks the whole game <-> site loop: heartbeat, join check, ban delivery,
 * events, action ack - plus the panel routes that back the UI.
 */
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { createKey } from '../src/apikeys.js';

const BASE = config.baseUrl;
let pass = 0;
let fail = 0;

function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

// --- credentials -------------------------------------------------
const key = createKey({ label: `smoke-test ${new Date().toISOString()}`, actor: null }).key;

// Gin outranks Game Owner; use whichever top account exists.
const owner =
  db.prepare("SELECT * FROM users WHERE role = 'gin' ORDER BY id LIMIT 1").get() ||
  db.prepare("SELECT * FROM users WHERE role = 'game_owner' ORDER BY id LIMIT 1").get();
if (!owner) {
  console.error('No gin or game_owner account exists. Run: node scripts/dev-seed.js');
  process.exit(1);
}
const sid = crypto.randomBytes(32).toString('base64url');
db.prepare(
  'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, NULL)'
).run(sid, owner.id, Date.now(), Date.now() + 3600_000, Date.now(), 'smoke-test');
const cookie = `zhc_sid=${sid}.${crypto.createHmac('sha256', config.sessionSecret).update(sid).digest('base64url')}`;

const gameHeaders = { 'Content-Type': 'application/json', 'X-ZHC-Key': key };
// Cookie-authed writes must carry a same-site Origin, so the harness sends one.
const panelHeaders = { 'Content-Type': 'application/json', Cookie: cookie, Origin: BASE };

const game = (path, body, method = 'POST') =>
  fetch(`${BASE}/api/game${path}`, { method, headers: gameHeaders, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const panel = (path, body, method = 'GET') =>
  fetch(`${BASE}/api${path}`, { method, headers: panelHeaders, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const SERVER_ID = 'smoke-test-server-0001';
const VICTIM = { userId: 991001, username: 'smoke_target', displayName: 'Smoke Target', accountAge: 400 };
const BYSTANDER = { userId: 991002, username: 'smoke_bystander', accountAge: 900 };

console.log(`\nZah Hood Central smoke test -> ${BASE}\n`);

// --- 1. auth ------------------------------------------------------
console.log('Authentication');
{
  const bad = await fetch(`${BASE}/api/game/ping`, { headers: { 'X-ZHC-Key': 'not-a-real-key' } });
  check('game API rejects a bad key', bad.status === 401);

  const good = await game('/ping', null, 'GET');
  check('game API accepts a real key', good.status === 200 && good.data.ok === true);

  const anon = await fetch(`${BASE}/api/stats/live`);
  check('panel API rejects anonymous callers', anon.status === 401);

  const me = await panel('/me');
  check('panel API accepts the session cookie',
    me.status === 200 && ['gin', 'game_owner'].includes(me.data.user.role));
}

// --- 2. heartbeat + presence ---------------------------------------
console.log('\nHeartbeat and presence');
{
  const beat = await game('/heartbeat', {
    serverId: SERVER_ID,
    placeId: '12345',
    region: 'US-West',
    players: [VICTIM, BYSTANDER],
    maxPlayers: 30,
    uptime: 120,
    fps: 59.4,
    ping: 38,
    memory: 1200,
    version: '117',
  });
  check('heartbeat accepted', beat.status === 200 && beat.data.ok === true);

  const view = await panel(`/servers/${SERVER_ID}`);
  check('server appears in the panel', view.status === 200 && view.data.server.id === SERVER_ID);
  check('roster has both players', view.data.players?.length === 2, `got ${view.data.players?.length}`);
  check('players were added to the database', !!(await panel(`/players/${VICTIM.userId}`)).data.player);

  // Drop one player from the heartbeat; the roster should shrink.
  await game('/heartbeat', { serverId: SERVER_ID, players: [BYSTANDER], maxPlayers: 30, uptime: 135 });
  const after = await panel(`/servers/${SERVER_ID}`);
  check('roster follows the heartbeat', after.data.players?.length === 1, `got ${after.data.players?.length}`);
}

// --- 3. bans reach the game ----------------------------------------
console.log('\nBan pipeline');
let punishmentId = null;
{
  const joinClean = await game('/join', { serverId: SERVER_ID, player: VICTIM });
  check('clean player is allowed in', joinClean.data.allowed === true && joinClean.data.banned === false);

  const ban = await panel(`/players/${VICTIM.userId}/punish`, {
    type: 'ban',
    reason: 'Smoke test ban',
    duration: '1d',
    username: VICTIM.username,
  }, 'POST');
  check('panel issued a ban', ban.status === 200 && ban.data.punishment.type === 'ban');
  punishmentId = ban.data.punishment.id;

  const joinBanned = await game('/join', { serverId: SERVER_ID, player: VICTIM });
  check('banned player is refused at join', joinBanned.data.allowed === false && joinBanned.data.banned === true);
  check('kick message carries the reason', String(joinBanned.data.ban?.message).includes('Smoke test ban'));

  const single = await game(`/check/${VICTIM.userId}`, null, 'GET');
  check('single-player ban check agrees', single.data.banned === true);

  const beat = await game('/heartbeat', { serverId: SERVER_ID, players: [VICTIM, BYSTANDER], maxPlayers: 30, uptime: 150 });
  const banAction = (beat.data.actions || []).find((a) => a.type === 'ban' && a.robloxId === VICTIM.userId);
  check('heartbeat delivers the ban action to the server', !!banAction);

  if (banAction) {
    const ack = await game('/ack', { ids: [banAction.id] });
    check('server can acknowledge the action', ack.data.acked === 1);
    const again = await game('/heartbeat', { serverId: SERVER_ID, players: [BYSTANDER], maxPlayers: 30, uptime: 165 });
    const repeat = (again.data.actions || []).find((a) => a.id === banAction.id);
    check('acknowledged actions are not re-delivered', !repeat);
  }

  const sync = await game(`/bans?since=0`, null, 'GET');
  check('ban sync lists the ban', sync.data.bans.some((b) => b.userId === VICTIM.userId));
}

// --- 4. lifting a ban ------------------------------------------------
console.log('\nLifting punishments');
{
  const revoke = await panel(`/punishments/${punishmentId}/revoke`, { reason: 'Smoke test cleanup' }, 'POST');
  check('ban can be lifted', revoke.status === 200 && revoke.data.punishment.active === false);

  const join = await game('/join', { serverId: SERVER_ID, player: VICTIM });
  check('player is allowed back in after the lift', join.data.allowed === true);

  const beat = await game('/heartbeat', { serverId: SERVER_ID, players: [VICTIM], maxPlayers: 30, uptime: 180 });
  check('unban is pushed to the server', (beat.data.actions || []).some((a) => a.type === 'unban'));
}

// --- 5. rank enforcement ----------------------------------------------
console.log('\nRole and rank enforcement');
{
  const chatMod = db.prepare("SELECT * FROM users WHERE role = 'chat_mod' LIMIT 1").get();
  if (!chatMod) {
    console.log('  SKIP  no chat_mod account seeded');
  } else {
    const lowSid = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    ).run(lowSid, chatMod.id, Date.now(), Date.now() + 3600_000, Date.now(), 'smoke-test');
    const lowCookie = `zhc_sid=${lowSid}.${crypto.createHmac('sha256', config.sessionSecret).update(lowSid).digest('base64url')}`;
    const asLow = (path, body, method = 'GET') =>
      fetch(`${BASE}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: lowCookie, Origin: BASE },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

    const warn = await asLow(`/players/${BYSTANDER.userId}/punish`, { type: 'warn', reason: 'rank test' }, 'POST');
    check('chat mod can warn', warn.status === 200);

    const ban = await asLow(`/players/${BYSTANDER.userId}/punish`, { type: 'ban', reason: 'rank test', duration: '1d' }, 'POST');
    check('chat mod cannot ban', ban.status === 403 && ban.data.error === 'missing_permission');

    const keys = await asLow('/apikeys');
    check('chat mod cannot see API keys', keys.status === 403);

    const promote = await asLow(`/staff/${owner.id}/role`, { role: 'moderator' }, 'POST');
    check('chat mod cannot change the owner’s role', promote.status === 403);

    const owners = await asLow('/chat/owners/messages');
    check('chat mod cannot read the owners room', owners.status === 403);

    const meta = await asLow('/meta');
    check('owners room is hidden from their channel list',
      !meta.data.channels?.some((c) => c.key === 'owners'));
  }
}

// --- 6. self-protection ------------------------------------------------
console.log('\nOwner guardrails');
{
  const selfDemote = await panel(`/staff/${owner.id}/role`, { role: 'moderator' }, 'POST');
  check('owner cannot demote themselves', selfDemote.status === 403);

  const tooHigh = db.prepare("SELECT * FROM users WHERE role = 'co_owner' LIMIT 1").get();
  if (tooHigh) {
    const promoteToOwner = await panel(`/staff/${tooHigh.id}/role`, { role: 'game_owner' }, 'POST');
    check('cannot hand out a protected role', promoteToOwner.status === 403);
  }
}

// --- 7. events and chat -------------------------------------------------
console.log('\nEvents and staff chat');
{
  const events = await game('/events', {
    serverId: SERVER_ID,
    events: [
      { type: 'robbery', userId: BYSTANDER.userId, username: BYSTANDER.username, detail: 'Corner store' },
      { type: 'kill', userId: BYSTANDER.userId, username: BYSTANDER.username, detail: 'drive-by' },
    ],
  });
  check('game events accepted', events.data.stored === 2);

  const feed = await panel('/feed?limit=10');
  check('events show up in the feed', feed.data.events.some((e) => e.detail === 'Corner store'));

  const msg = await panel('/chat/general/messages', { body: 'smoke test message' }, 'POST');
  check('staff chat accepts a message', msg.status === 200 && msg.data.message.body === 'smoke test message');

  const read = await panel('/chat/general/messages');
  check('staff chat returns it', read.data.messages.some((m) => m.body === 'smoke test message'));

  const del = await panel(`/chat/messages/${msg.data.message.id}`, null, 'DELETE');
  check('staff chat message can be deleted', del.status === 200);
}

// --- 8. lookups -----------------------------------------------------------
console.log('\nLookups');
{
  const search = await panel(`/players?q=${VICTIM.username}`);
  check('player search finds by username', search.data.players.some((p) => p.robloxId === VICTIM.userId));

  const byId = await panel(`/players?q=${VICTIM.userId}`);
  check('player search finds by user ID', byId.data.players.some((p) => p.robloxId === VICTIM.userId));

  const missing = await panel('/servers/does-not-exist-at-all');
  check('unknown server ID returns a clean 404', missing.status === 404 && missing.data.error === 'server_not_found');

  const audit = await panel('/audit?limit=20');
  check('audit log recorded the ban', audit.data.entries.some((e) => e.action === 'punish.ban'));
}

// --- 9. whitelist --------------------------------------------------------
console.log('\nWhitelist');
{
  const TEST_ID = '999888777666555444';
  db.prepare('DELETE FROM whitelist WHERE discord_id = ?').run(TEST_ID);

  const add = await panel('/whitelist', { discordId: TEST_ID, label: 'smoke test entry' }, 'POST');
  check('an ID can be whitelisted', add.status === 200);

  const list = await panel('/whitelist');
  check('whitelist lists the entry', list.data.entries.some((e) => e.discordId === TEST_ID));
  check('whitelist reports it is enabled', list.data.enabled === true);

  const bad = await panel('/whitelist', { discordId: 'not-a-snowflake' }, 'POST');
  check('a malformed Discord ID is rejected', bad.status === 400);

  const ownerId = process.env.OWNER_DISCORD_ID || config.discord.ownerId;
  if (ownerId) {
    db.prepare(
      'INSERT OR IGNORE INTO whitelist (discord_id, label, added_at) VALUES (?, ?, ?)'
    ).run(ownerId, 'configured owner', Date.now());
    const delOwner = await panel(`/whitelist/${ownerId}`, null, 'DELETE');
    check('the configured owner cannot be de-whitelisted', delOwner.status === 403);
  }

  const del = await panel(`/whitelist/${TEST_ID}`, null, 'DELETE');
  check('an entry can be revoked', del.status === 200);
}

// --- 10. the owner role is unreachable -----------------------------------
console.log('\nGame Owner cannot be granted');
{
  // Someone who is neither the caller nor already on a protected rank.
  const victim = db
    .prepare("SELECT * FROM users WHERE role NOT IN ('gin', 'game_owner') AND id != ? ORDER BY id LIMIT 1")
    .get(owner.id);
  if (!victim) {
    console.log('  SKIP  no non-owner account to test with');
  } else {
    const grant = await panel(`/staff/${victim.id}/role`, { role: 'game_owner' }, 'POST');
    check('even the owner cannot grant game_owner via the API',
      grant.status === 403 && grant.data.error === 'owner_role_is_env_only');

    const meta = await panel('/meta');
    check('game_owner is absent from the assignable list',
      !meta.data.assignable?.includes('game_owner'));

    const demote = await panel(`/staff/${owner.id}/role`, { role: 'moderator' }, 'POST');
    check('the top account cannot be demoted through the API', demote.status === 403);
  }
}

// --- 11. role renaming -----------------------------------------------------
console.log('\nRole renaming');
{
  const rename = await panel('/roles/moderator', { name: 'Street Mod', color: '#12ab34' }, 'POST');
  check('the owner can rename a rank', rename.status === 200 && rename.data.role.name === 'Street Mod');

  const meta = await panel('/meta');
  const moderator = meta.data.roles.find((r) => r.key === 'moderator');
  check('the new name is served to the panel', moderator?.name === 'Street Mod');
  check('the rank number is unchanged', moderator?.rank === 20);
  check('the original name is remembered', moderator?.defaultName === 'Moderator');

  const badColor = await panel('/roles/moderator', { name: 'x', color: 'red' }, 'POST');
  check('a non-hex colour is rejected', badColor.status === 400);

  const badRole = await panel('/roles/not_a_role', { name: 'x' }, 'POST');
  check('an unknown role key is rejected', badRole.status === 400);

  const reset = await panel('/roles/moderator', null, 'DELETE');
  check('a rename can be reset', reset.status === 200 && reset.data.role.name === 'Moderator');

  const chatMod = db.prepare("SELECT * FROM users WHERE role = 'chat_mod' LIMIT 1").get();
  if (chatMod) {
    const lowSid = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    ).run(lowSid, chatMod.id, Date.now(), Date.now() + 3600_000, Date.now(), 'smoke-test');
    const lowCookie = `zhc_sid=${lowSid}.${crypto.createHmac('sha256', config.sessionSecret).update(lowSid).digest('base64url')}`;
    const res = await fetch(`${BASE}/api/roles/moderator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: lowCookie, Origin: BASE },
      body: JSON.stringify({ name: 'Hacked' }),
    });
    check('a chat mod cannot rename ranks', res.status === 403);
  }
}

// --- 12. request hardening --------------------------------------------------
console.log('\nRequest hardening');
{
  const noOrigin = await fetch(`${BASE}/api/whitelist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ discordId: '111111111111111111' }),
  });
  check('a cookie-authed write with no Origin is blocked', noOrigin.status === 403);

  const evilOrigin = await fetch(`${BASE}/api/whitelist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.example' },
    body: JSON.stringify({ discordId: '111111111111111111' }),
  });
  check('a cross-site Origin is blocked', evilOrigin.status === 403);

  const reads = await fetch(`${BASE}/api/stats/live`, { headers: { Cookie: cookie } });
  check('reads still work without an Origin header', reads.status === 200);

  const headers = await fetch(`${BASE}/`);
  check('CSP header is sent', !!headers.headers.get('content-security-policy'));
  check('clickjacking is blocked', headers.headers.get('x-frame-options') === 'DENY');
  check('MIME sniffing is blocked', headers.headers.get('x-content-type-options') === 'nosniff');

  const forged = crypto.randomBytes(32).toString('base64url');
  const forgedCookie = `zhc_sid=${forged}.${crypto.randomBytes(32).toString('base64url')}`;
  const forgedRes = await fetch(`${BASE}/api/me`, { headers: { Cookie: forgedCookie } });
  check('a forged session cookie is rejected', forgedRes.status === 401);

  const unsigned = await fetch(`${BASE}/api/me`, { headers: { Cookie: `zhc_sid=${sid}` } });
  check('an unsigned session id is rejected', unsigned.status === 401);
}

// --- 13. permission editor --------------------------------------------------
console.log('\nPermission editor');
{
  await panel('/permissions', null, 'DELETE'); // start from defaults

  const matrix = await panel('/permissions');
  check('the matrix loads', matrix.status === 200 && matrix.data.permissions.length > 20);
  check('every rank has a column', matrix.data.roles.length === 14);

  const banPerm = matrix.data.permissions.find((p) => p.key === 'punish.ban.perm');
  check('chat mod cannot permanently ban by default', banPerm.grants.chat_mod.allowed === false);

  // Grant it, then prove it actually takes effect on a real request.
  const grant = await panel('/permissions', { role: 'chat_mod', permission: 'punish.ban.perm', allowed: true }, 'POST');
  check('a permission can be granted to a rank', grant.status === 200);
  check('the matrix marks it as changed from default',
    grant.data.matrix.permissions.find((p) => p.key === 'punish.ban.perm').grants.chat_mod.overridden === true);

  const chatMod = db.prepare("SELECT * FROM users WHERE role = 'chat_mod' LIMIT 1").get();
  if (chatMod) {
    const lowSid = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    ).run(lowSid, chatMod.id, Date.now(), Date.now() + 3600_000, Date.now(), 'smoke-test');
    const lowCookie = `zhc_sid=${lowSid}.${crypto.createHmac('sha256', config.sessionSecret).update(lowSid).digest('base64url')}`;
    const asLow = (path, body, method = 'GET') =>
      fetch(`${BASE}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: lowCookie, Origin: BASE },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

    const ban = await asLow(`/players/${BYSTANDER.userId}/punish`, { type: 'ban', reason: 'perm grant test' }, 'POST');
    check('the granted rank can now actually do it', ban.status === 200);
    if (ban.status === 200) {
      await panel(`/punishments/${ban.data.punishment.id}/revoke`, { reason: 'test cleanup' }, 'POST');
    }

    // Revoke something they normally have, and prove it is taken away.
    await panel('/permissions', { role: 'chat_mod', permission: 'punish.warn', allowed: false }, 'POST');
    const warn = await asLow(`/players/${BYSTANDER.userId}/punish`, { type: 'warn', reason: 'should fail' }, 'POST');
    check('a revoked permission is actually denied', warn.status === 403);

    // Rank rules survive a permission grant.
    await panel('/permissions', { role: 'chat_mod', permission: 'staff.manage', allowed: true }, 'POST');
    const promote = await asLow(`/staff/${owner.id}/role`, { role: 'moderator' }, 'POST');
    check('promote rights still cannot reach a higher rank', promote.status === 403);
    const grantOwner = await asLow(`/staff/${chatMod.id}/role`, { role: 'game_owner' }, 'POST');
    check('promote rights still cannot grant game_owner', grantOwner.status === 403);

    const editPerms = await asLow('/permissions', { role: 'chat_mod', permission: 'db.purge', allowed: true }, 'POST');
    check('a granted rank still cannot open the permission editor', editPerms.status === 403);
  }

  const locked = await panel('/permissions', { role: 'chat_mod', permission: 'roles.permissions', allowed: true }, 'POST');
  check('the locked meta permission cannot be granted',
    locked.status === 400 && locked.data.error === 'permission_locked');

  const lockedRename = await panel('/permissions', { role: 'co_owner', permission: 'roles.rename', allowed: true }, 'POST');
  check('rank renaming cannot be handed out either', lockedRename.status === 400);

  const badPerm = await panel('/permissions', { role: 'chat_mod', permission: 'not.a.permission', allowed: true }, 'POST');
  check('an unknown permission is rejected', badPerm.status === 400);

  const badRoleKey = await panel('/permissions', { role: 'nope', permission: 'db.view', allowed: true }, 'POST');
  check('an unknown rank is rejected', badRoleKey.status === 400);

  const reset = await panel('/permissions', null, 'DELETE');
  check('everything can be reset to defaults', reset.status === 200);
  const after = reset.data.matrix.permissions.find((p) => p.key === 'punish.ban.perm');
  check('defaults really are restored', after.grants.chat_mod.allowed === false);
}

// --- 14. Gin and website traffic ---------------------------------------------
console.log('\nGin and website traffic');
{
  const meta = await panel('/meta');
  const gin = meta.data.roles.find((r) => r.key === 'gin');
  check('Gin exists in the ladder', !!gin);
  check('Gin sits above Game Owner', gin.rank > meta.data.roles.find((r) => r.key === 'game_owner').rank);
  check('Gin is not assignable to anyone', !meta.data.assignable?.includes('gin'));

  const matrix = await panel('/permissions');
  check('Gin has no column in the permission editor',
    !matrix.data.roles.some((r) => r.key === 'gin'));

  const editGin = await panel('/permissions', { role: 'gin', permission: 'db.view', allowed: false }, 'POST');
  check('Gin permissions cannot be edited', editGin.status === 400 && editGin.data.error === 'role_not_editable');

  const grantTraffic = await panel('/permissions', { role: 'co_owner', permission: 'traffic.view', allowed: true }, 'POST');
  check('traffic.view cannot be granted to anyone',
    grantTraffic.status === 400 && grantTraffic.data.error === 'permission_locked');

  const promoteGin = await panel(`/staff/${owner.id}/role`, { role: 'gin' }, 'POST');
  check('nobody can be promoted to Gin', promoteGin.status === 403);

  const traffic = await panel('/traffic');
  const ginHolder = db.prepare("SELECT 1 AS x FROM users WHERE role = 'gin'").get();
  if (ginHolder) {
    check('Gin can read website traffic', traffic.status === 200 && Array.isArray(traffic.data.online));
    check('traffic reports totals', typeof traffic.data.totals?.views24h === 'number');

    const profile = await panel(`/traffic/${owner.id}`);
    check('a visitor profile loads', profile.status === 200 && profile.data.user.id === owner.id);
    check('the profile carries sessions', Array.isArray(profile.data.sessions));
    check('the profile carries page views', Array.isArray(profile.data.pageViews));
    check('the profile carries their actions', Array.isArray(profile.data.actions));
  } else {
    console.log('  SKIP  no gin account configured (set GIN_DISCORD_ID)');
  }

  // Anyone below Gin must be refused, no matter how senior.
  const coOwner = db.prepare("SELECT * FROM users WHERE role = 'co_owner' LIMIT 1").get();
  if (coOwner) {
    const sid2 = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    ).run(sid2, coOwner.id, Date.now(), Date.now() + 3600_000, Date.now(), 'smoke-test');
    const c2 = `zhc_sid=${sid2}.${crypto.createHmac('sha256', config.sessionSecret).update(sid2).digest('base64url')}`;
    const denied = await fetch(`${BASE}/api/traffic`, { headers: { Cookie: c2 } });
    check('a Co-Owner cannot see website traffic', denied.status === 403);
    const deniedProfile = await fetch(`${BASE}/api/traffic/${owner.id}`, { headers: { Cookie: c2 } });
    check('a Co-Owner cannot open a visitor profile', deniedProfile.status === 403);
  }

  await panel('/permissions', null, 'DELETE');
}

// --- cleanup --------------------------------------------------------------
db.prepare('DELETE FROM sessions WHERE ip = ?').run('smoke-test');
db.prepare("DELETE FROM login_attempts WHERE ip = 'smoke-test'").run();
db.prepare('UPDATE api_keys SET revoked_at = ? WHERE label LIKE ?').run(Date.now(), 'smoke-test %');
db.prepare('DELETE FROM server_players WHERE server_id = ?').run(SERVER_ID);
db.prepare('DELETE FROM servers WHERE id = ?').run(SERVER_ID);

console.log(`\n${'='.repeat(46)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);

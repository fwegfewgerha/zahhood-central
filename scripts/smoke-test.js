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

// --- staff Roblox verification gate ------------------------------------------
console.log('\nStaff Roblox verification');
{
  const { setSetting } = await import('../src/db.js');
  const { linkedAccounts } = await import('../src/roblox.js');

  db.prepare('DELETE FROM roblox_links WHERE user_id = ?').run(owner.id);
  setSetting('require_staff_roblox', '1', null);

  check('an unverified staff member has no linked account', linkedAccounts(owner).length === 0);

  const blocked = await panel('/stats/live');
  check('the panel is closed until they verify',
    blocked.status === 403 && blocked.data.error === 'roblox_verification_required');

  const meWhileBlocked = await panel('/me');
  check('but /me still works, so the screen can be shown',
    meWhileBlocked.status === 200 && meWhileBlocked.data.needsRobloxLink === true);

  const linkStatus = await panel('/link/status');
  check('the verification endpoint stays reachable', linkStatus.status === 200);

  // Stand in for a completed profile check.
  db.prepare('INSERT INTO roblox_links (user_id, roblox_id, roblox_username, verified_at) VALUES (?, ?, ?, ?)')
    .run(owner.id, 700001, 'owner_account', Date.now());

  const allowed = await panel('/stats/live');
  check('the panel opens once an account is proved', allowed.status === 200);

  const meAfter = await panel('/me');
  check('/me stops asking once linked', meAfter.data.needsRobloxLink === false);

  // The rest of the suite drives several seeded staff accounts, none of which
  // have linked an account, so the requirement stands down from here.
  setSetting('require_staff_roblox', '0', null);
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
  // Derived rather than hard-coded, so adding a rank does not fail this.
  const { publicRoleList } = await import('../src/roles.js');
  const editable = publicRoleList().filter((r) => r.key !== 'gin');
  check('every rank except Gin has a column',
    matrix.data.roles.length === editable.length && editable.length > 1);

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

// --- 15. the configured owner can always get in ------------------------------
// Regression guard: the whitelist bypass once checked only OWNER_DISCORD_ID,
// so configuring GIN_DISCORD_ID alone locked the site's own owner out.
console.log('\nOwner lockout guard');
{
  const { entitledRole } = await import('../src/auth.js');
  const { ginId, ownerId } = config.discord;

  if (ginId) {
    check('the configured Gin resolves to the gin rank', entitledRole(ginId) === 'gin');
    check('the configured Gin bypasses an empty whitelist', !!entitledRole(ginId));
  }
  if (ownerId && ownerId !== ginId) {
    check('the configured owner resolves to game_owner', entitledRole(ownerId) === 'game_owner');
  }
  check('a stranger is entitled to nothing', entitledRole('999999999999999999') === null);
  check('an empty id is entitled to nothing', entitledRole('') === null && entitledRole(null) === null);
  check('at least one protected account is configured', !!(ginId || ownerId));

  // Gin must win when both variables name the same account.
  if (ginId && ownerId && ginId === ownerId) {
    check('Gin takes precedence when both IDs match', entitledRole(ginId) === 'gin');
  }
}

// --- 16. the appeal flow ------------------------------------------------------
// Signing in is required, but the whitelist is not - a banned player is never
// whitelisted. Ban details stay hidden until they prove the Roblox account is
// theirs.
console.log('\nAppeal flow');
{
  const t = Date.now();
  const APPEAL_DISCORD = '888777666555444333';
  const ROBLOX = 992001;
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(APPEAL_DISCORD);
  db.prepare('DELETE FROM punishments WHERE roblox_id = ?').run(ROBLOX);
  db.prepare('DELETE FROM players WHERE roblox_id = ?').run(ROBLOX);
  db.prepare('INSERT INTO players (roblox_id, username, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(ROBLOX, 'banned_player', t, t);
  db.prepare(
    "INSERT INTO users (discord_id, discord_username, role, created_at, last_login_at, last_seen_at) VALUES (?, 'banned_player', 'member', ?, ?, ?)"
  ).run(APPEAL_DISCORD, t, t, t);
  const appealUser = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(APPEAL_DISCORD);

  const aSid = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, NULL)'
  ).run(aSid, appealUser.id, t, t + 3600000, t, 'smoke-test');
  const aCookie = `zhc_sid=${aSid}.${crypto.createHmac('sha256', config.sessionSecret).update(aSid).digest('base64url')}`;
  const asPlayer = (path, body, method = 'GET') =>
    fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: aCookie, Origin: BASE },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

  const anon = await fetch(`${BASE}/api/appeal/lookup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{}',
  });
  check('an anonymous visitor cannot look up a ban', anon.status === 401);

  const cfg = await fetch(`${BASE}/api/appeal/config`).then((r) => r.json());
  check('the appeal config is public', cfg.open === true);

  const unverified = await asPlayer('/api/appeal/lookup', {}, 'POST');
  check('ban details are hidden until the Roblox account is verified',
    unverified.status === 403 && unverified.data.error === 'roblox_not_verified');

  const panelProbe = await asPlayer('/api/stats/live');
  check('an appellant cannot reach the panel', panelProbe.status === 403);
  const dbProbe = await asPlayer('/api/players');
  check('an appellant cannot read the player database', dbProbe.status === 403);

  // Stand in for a completed profile-description verification.
  db.prepare('DELETE FROM roblox_links WHERE roblox_id IN (?, ?)').run(ROBLOX, ROBLOX + 1);
  db.prepare('INSERT INTO roblox_links (user_id, roblox_id, roblox_username, verified_at) VALUES (?, ?, ?, ?)')
    .run(appealUser.id, ROBLOX, 'banned_player', t);
  db.prepare('UPDATE users SET roblox_user_id = ?, roblox_username = ?, roblox_verified_at = ? WHERE id = ?')
    .run(ROBLOX, 'banned_player', t, appealUser.id);

  const noBan = await asPlayer('/api/appeal/lookup', {}, 'POST');
  check('a verified player with no ban is told so', noBan.status === 200 && noBan.data.banned === false);

  const ban = await panel(`/players/${ROBLOX}/punish`, {
    type: 'ban', reason: 'appeal flow test', username: 'banned_player',
    evidence: 'https://example.com/clip.mp4',
  }, 'POST');
  check('a ban with evidence can be placed', ban.status === 200);
  check('the ban carries an appeal code', typeof ban.data.punishment.appealCode === 'string');

  const look = await asPlayer('/api/appeal/lookup', {}, 'POST');
  check('a verified player sees their ban', look.status === 200 && look.data.banned === true);
  check('they see the reason', look.data.ban.reason === 'appeal flow test');
  check('they see the evidence clip', look.data.ban.evidence === 'https://example.com/clip.mp4');

  const short = await asPlayer('/api/appeal/start', { body: 'nope' }, 'POST');
  check('a one-liner appeal is rejected', short.status === 400);

  const filed = await asPlayer('/api/appeal/start', {
    body: 'It was my little brother on my account. I have changed my password and it will not happen again.',
  }, 'POST');
  check('the appeal can be filed', filed.status === 200);

  const mine = await asPlayer('/api/appeal/mine');
  // System notices (waiting to be claimed, and so on) sit alongside the real
  // messages, so count only what people actually said.
  const said = (r) => r.data.appeal.messages.filter((m) => m.from !== 'system');
  check('the conversation opens with their message',
    mine.status === 200 && said(mine).length === 1);

  const queue = await panel('/appeals?status=pending');
  const appealId = queue.data.appeals.find((a) => a.robloxId === ROBLOX)?.id;
  check('staff see it in the queue', !!appealId);

  const thread = await panel(`/appeals/${appealId}/messages`);
  check('staff can open the conversation',
    thread.status === 200 && thread.data.messages.filter((m) => m.from !== 'system').length === 1);

  const reply = await panel(`/appeals/${appealId}/messages`, { body: 'Which account was your brother on?' }, 'POST');
  check('staff can reply', reply.status === 200);

  const afterReply = await asPlayer('/api/appeal/mine');
  const spoken = said(afterReply);
  check('the player sees the reply', spoken.length === 2);
  check('the player sees a rank, not a staff name',
    spoken[1].from === 'staff' && spoken[1].author === 'Gin');

  const tooEarly = await asPlayer('/api/appeal/mine/message', { body: 'Hello?' }, 'POST');
  check('the player cannot speak before the ticket is claimed',
    tooEarly.status === 409 && tooEarly.data.error === 'awaiting_claim');

  const waiting = await asPlayer('/api/appeal/mine');
  check('they are told it is waiting to be claimed', waiting.data.appeal.claimed === false);

  const claimed = await panel(`/appeals/${appealId}/claim`, {}, 'POST');
  check('a moderator can claim the ticket', claimed.status === 200);

  const reclaim = await panel(`/appeals/${appealId}/claim`, {}, 'POST');
  check('claiming your own ticket again is harmless', reclaim.status === 200);

  const afterClaim = await asPlayer('/api/appeal/mine');
  check('the appellant sees it is claimed', afterClaim.data.appeal.claimed === true);
  check('they are told the rank, not the name', afterClaim.data.appeal.claimedByRole === 'Gin');

  const playerReply = await asPlayer('/api/appeal/mine/message', { body: 'He does not have his own account.' }, 'POST');
  check('the player can reply once it is claimed', playerReply.status === 200);

  const chatMod = db.prepare("SELECT * FROM users WHERE role = 'chat_mod' LIMIT 1").get();
  if (chatMod) {
    const lowSid = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    ).run(lowSid, chatMod.id, t, t + 3600000, t, 'smoke-test');
    const lc = `zhc_sid=${lowSid}.${crypto.createHmac('sha256', config.sessionSecret).update(lowSid).digest('base64url')}`;
    const denied = await fetch(`${BASE}/api/appeals/${appealId}/messages`, { headers: { Cookie: lc } });
    check('a chat mod cannot read the appeal conversation', denied.status === 403);
  }

  const decided = await panel(`/appeals/${appealId}`, { decision: 'accepted', response: 'Lifted. Secure your account.' }, 'POST');
  check('accepting the appeal works', decided.status === 200);

  const closed = await asPlayer('/api/appeal/mine');
  check('the verdict lands in the conversation',
    closed.data.appeal.messages.some((m) => m.body.includes('lifted')));
  check('the appeal reads as accepted', closed.data.appeal.status === 'accepted');
  check('the ban is gone', closed.data.appeal.ban.active === false);

  const late = await asPlayer('/api/appeal/mine/message', { body: 'One more thing' }, 'POST');
  check('a closed appeal refuses new messages', late.status === 409);

  // A second proved account is a confirmed alt, traceable to the same person.
  const ALT = ROBLOX + 1;
  db.prepare('INSERT OR IGNORE INTO players (roblox_id, username, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(ALT, 'banned_player_alt', t, t);
  db.prepare('INSERT INTO roblox_links (user_id, roblox_id, roblox_username, verified_at) VALUES (?, ?, ?, ?)')
    .run(appealUser.id, ALT, 'banned_player_alt', t);

  const both = await asPlayer('/api/appeal/verify/status');
  check('both linked accounts are listed', both.data.accounts?.length === 2);

  const profile = await panel(`/players/${ALT}`);
  check('the player profile names the verified owner',
    profile.data.identity?.discordId === APPEAL_DISCORD);
  check('the profile lists the confirmed alt',
    profile.data.identity?.alsoOwns?.some((a) => a.robloxId === ROBLOX));

  const otherDirection = await panel(`/players/${ROBLOX}`);
  check('the trace works from either account',
    otherDirection.data.identity?.alsoOwns?.some((a) => a.robloxId === ALT));

  // An account somebody else proved cannot be looked up.
  const notMine = await asPlayer('/api/appeal/lookup', { robloxId: 123456789 }, 'POST');
  check('an unlinked account cannot be looked up', notMine.status === 403);

  db.prepare('DELETE FROM roblox_links WHERE user_id = ?').run(appealUser.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(appealUser.id);
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(APPEAL_DISCORD);
  db.prepare('DELETE FROM punishments WHERE roblox_id IN (?, ?)').run(ROBLOX, ALT);
  db.prepare('DELETE FROM players WHERE roblox_id IN (?, ?)').run(ROBLOX, ALT);
}

// --- 17. the bot can only mute --------------------------------------------
console.log('\nBot capability lock');
{
  const { assertAllowed, botInviteUrl, MODERATE_MEMBERS } = await import('../src/discordbot.js');
  const G = '123456789012345678';
  const U = '234567890123456789';
  const refuses = (m, p, b) => {
    try { assertAllowed(m, p, b); return false; } catch { return true; }
  };
  const allows = (m, p, b) => !refuses(m, p, b);

  check('reading a member is allowed', allows('GET', `/guilds/${G}/members/${U}`));
  check('searching members is allowed', allows('GET', `/guilds/${G}/members/search?query=x&limit=10`));
  check('applying a timeout is allowed',
    allows('PATCH', `/guilds/${G}/members/${U}`, { communication_disabled_until: null }));

  check('banning is refused', refuses('PUT', `/guilds/${G}/bans/${U}`));
  check('kicking is refused', refuses('DELETE', `/guilds/${G}/members/${U}`));
  check('sending a message is refused', refuses('POST', `/channels/${G}/messages`));
  check('deleting a message is refused', refuses('DELETE', `/channels/${G}/messages/${U}`));
  check('changing roles is refused', refuses('PUT', `/guilds/${G}/members/${U}/roles/${U}`));
  check('editing the guild is refused', refuses('PATCH', `/guilds/${G}`));

  // A timeout write must not be able to smuggle other fields along with it.
  check('a write carrying extra fields is refused',
    refuses('PATCH', `/guilds/${G}/members/${U}`, { communication_disabled_until: null, roles: ['x'] }));
  check('a write that only changes a nickname is refused',
    refuses('PATCH', `/guilds/${G}/members/${U}`, { nick: 'renamed' }));

  check('the invite grants only Moderate Members',
    (botInviteUrl() || '').includes(`permissions=${MODERATE_MEMBERS}`));
  check('the invite requests no privileged scopes',
    !(botInviteUrl() || '').includes('applications.commands'));
}

// --- 18. a mute needs a screenshot -------------------------------------------
console.log('\nMute evidence');
{
  // A 1x1 PNG, with correct magic bytes.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const asDataUrl = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;

  const noEvidence = await panel('/chatmod/mute', {
    discordId: '123456789012345678', reason: 'test', duration: '10m',
  }, 'POST');
  check('a mute without a screenshot is refused',
    noEvidence.status === 400 && noEvidence.data.error === 'evidence_required');

  const bogusId = await panel('/chatmod/mute', {
    discordId: '123456789012345678', reason: 'test', duration: '10m', evidenceId: 999999,
  }, 'POST');
  check('a made-up evidence id is refused', bogusId.status === 400);

  const notImage = await panel('/chatmod/evidence', {
    image: asDataUrl(Buffer.from('this is plainly not a png'), 'image/png'),
  }, 'POST');
  check('a non-image pretending to be a PNG is refused',
    notImage.status === 415 && notImage.data.error === 'not_an_image');

  const wrongType = await panel('/chatmod/evidence', {
    image: asDataUrl(PNG, 'application/pdf'),
  }, 'POST');
  check('a non-image type is refused', wrongType.status === 415);

  const empty = await panel('/chatmod/evidence', { image: 'not-a-data-url' }, 'POST');
  check('a malformed upload is refused', empty.status === 400);

  const up = await panel('/chatmod/evidence', { image: asDataUrl(PNG, 'image/png') }, 'POST');
  check('a real PNG uploads', up.status === 200 && typeof up.data.evidenceId === 'number');

  const served = await fetch(`${BASE}/api/chatmod/evidence/${up.data.evidenceId}`, {
    headers: { Cookie: cookie },
  });
  check('the screenshot serves back to staff',
    served.status === 200 && served.headers.get('content-type') === 'image/png');

  const anon = await fetch(`${BASE}/api/chatmod/evidence/${up.data.evidenceId}`);
  check('the screenshot is not public', anon.status === 401);

  // Somebody else's upload cannot be borrowed.
  const chatMod = db.prepare("SELECT * FROM users WHERE role = 'chat_mod' LIMIT 1").get();
  if (chatMod) {
    const lowSid = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    ).run(lowSid, chatMod.id, Date.now(), Date.now() + 3600000, Date.now(), 'smoke-test');
    const lc = `zhc_sid=${lowSid}.${crypto.createHmac('sha256', config.sessionSecret).update(lowSid).digest('base64url')}`;
    const borrowed = await fetch(`${BASE}/api/chatmod/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: lc, Origin: BASE },
      body: JSON.stringify({
        discordId: '123456789012345678', reason: 'borrowing', duration: '10m',
        evidenceId: up.data.evidenceId,
      }),
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
    check('another staff member cannot use your screenshot',
      borrowed.status === 403 && borrowed.data.error === 'evidence_not_yours');
  }

  db.prepare('DELETE FROM mute_evidence WHERE id = ?').run(up.data.evidenceId);
}

// --- 19. the record outlives the screenshot ----------------------------------
console.log('\nMute record retention');
{
  const { pruneEvidence } = await import('../src/stats.js');
  const { setSetting } = await import('../src/db.js');
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const TARGET = '424242424242424242';
  db.prepare('DELETE FROM chat_mutes WHERE discord_id = ?').run(TARGET);

  const t = Date.now();
  const old = Date.now() - 200 * 864e5;
  const gin = db.prepare("SELECT * FROM users WHERE role IN ('gin','game_owner') ORDER BY id LIMIT 1").get();

  const mkEvidence = (createdAt) =>
    Number(db.prepare(
      `INSERT INTO mute_evidence (mime, bytes, byte_size, sha256, uploaded_by, uploaded_by_name, created_at, used)
       VALUES ('image/png', ?, ?, 'x', ?, ?, ?, 1)`
    ).run(PNG, PNG.length, gin.id, gin.discord_username, createdAt).lastInsertRowid);

  const oldEv = mkEvidence(old);
  const newEv = mkEvidence(t);
  const mkMute = (evId, at) =>
    db.prepare(
      `INSERT INTO chat_mutes (discord_id, discord_name, reason, issued_by, issued_by_name, issued_by_role,
                               issued_at, expires_at, active, delivered, evidence_id)
       VALUES (?, 'RepeatOffender', 'test mute', ?, ?, ?, ?, ?, 0, 1, ?)`
    ).run(TARGET, gin.id, gin.discord_username, gin.role, at, at + 600000, evId);

  mkMute(oldEv, old);
  mkMute(newEv, t);

  const before = await panel('/chatmod');
  check('both mutes are on record', before.data.history.filter((m) => m.discordId === TARGET).length === 2);

  setSetting('evidence_retention_days', '90', null);
  const dropped = pruneEvidence();
  check('the old screenshot is pruned', dropped >= 1);

  const after = await panel('/chatmod');
  const mine = after.data.history.filter((m) => m.discordId === TARGET);
  check('the mute records survive the prune', mine.length === 2);
  check('the recent screenshot is still there', mine.some((m) => m.evidenceAvailable));
  check('the old screenshot reads as expired, not missing', mine.some((m) => m.evidenceExpired));

  // Their count is what follows them around.
  const total = db.prepare('SELECT COUNT(*) AS n FROM chat_mutes WHERE discord_id = ?').get(TARGET).n;
  check('the mute count is unaffected by pruning', total === 2);

  db.prepare('DELETE FROM chat_mutes WHERE discord_id = ?').run(TARGET);
  db.prepare('DELETE FROM mute_evidence WHERE id IN (?, ?)').run(oldEv, newEv);
  setSetting('evidence_retention_days', '90', null);
}

// --- 20. the Developer role ---------------------------------------------------
// A Developer sits high so nobody below can punish or demote them, but the
// role is technical: it gets the game keys and no authority over people.
console.log('\nDeveloper role');
{
  const { can, rankOf, outranks, assignableRoles } = await import('../src/roles.js');

  check('Developer sits between Owner Assistant and Co-Owner',
    rankOf('dev') > rankOf('owner_assistant') && rankOf('dev') < rankOf('co_owner'));
  check('Developer outranks every moderation rank', outranks('dev', 'head_admin'));
  check('Co-Owner still outranks a Developer', outranks('co_owner', 'dev'));

  check('a Developer can manage the game keys', can('dev', 'apikeys.manage'));
  check('a Developer can see live servers', can('dev', 'servers.view'));
  check('a Developer can read the audit log', can('dev', 'audit.view'));

  // The point of the role defaults: rank alone would have granted these.
  check('rank alone would have granted staff.manage', rankOf('dev') >= 70);
  check('but a Developer cannot promote or demote', !can('dev', 'staff.manage'));
  check('a Developer cannot suspend staff', !can('dev', 'staff.remove'));
  check('a Developer cannot edit the whitelist', !can('dev', 'whitelist.manage'));
  check('a Developer cannot permanently ban', !can('dev', 'punish.ban.perm'));

  check('Co-Owner can appoint a Developer', assignableRoles('co_owner').includes('dev'));
  check('Owner Assistant cannot appoint a Developer',
    !assignableRoles('owner_assistant').includes('dev'));

  // The role is ordinary, so the owner can still change any of it.
  const matrix = await panel('/permissions');
  check('Developer appears in the permission editor',
    matrix.data.roles.some((r) => r.key === 'dev'));
  const staffManage = matrix.data.permissions.find((p) => p.key === 'staff.manage');
  check('its withheld permissions do not read as owner edits',
    staffManage.grants.dev.allowed === false && staffManage.grants.dev.overridden === false);

  const grant = await panel('/permissions', { role: 'dev', permission: 'staff.manage', allowed: true }, 'POST');
  check('the owner can still grant it if they want', grant.status === 200);
  const after = grant.data.matrix.permissions.find((p) => p.key === 'staff.manage');
  check('and that now reads as a change from default', after.grants.dev.overridden === true);
  await panel('/permissions?role=dev', null, 'DELETE');

  const back = await panel('/permissions');
  check('resetting returns it to the role default',
    back.data.permissions.find((p) => p.key === 'staff.manage').grants.dev.allowed === false);
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

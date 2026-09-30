import express from 'express';
import { db, now, audit, jsonOr, isWhitelistEnabled, setSetting } from '../db.js';
import { config, SITE } from '../config.js';
import { publicUser, requireLogin, requireStaff, requirePerm, avatarUrl, clientIp } from '../auth.js';
import {
  can, rankOf, role as roleInfo, publicRoleList, assignableRoles, outranks, isStaff,
  setRoleAppearance, resetRoleAppearance,
} from '../roles.js';
import { broadcast, onlineStaff } from '../realtime.js';
import { liveSnapshot, history, reapDeadServers } from '../stats.js';
import {
  issuePunishment,
  revokePunishment,
  punishmentsFor,
  activeBan,
  shapePunishment,
  parseDuration,
  queueAction,
  expirePunishments,
} from '../moderation.js';
import { createKey, listKeys, revokeKey } from '../apikeys.js';
import { auditConfiguration } from '../security.js';

export const apiRouter = express.Router();

const int = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max));

export function headshot(robloxId) {
  return `https://www.roblox.com/headshot-thumbnail/image?userId=${robloxId}&width=150&height=150&format=png`;
}

// ---------------------------------------------------------------
// session + metadata (the only routes a non-staff member may reach)
// ---------------------------------------------------------------
apiRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not_authenticated', login: '/auth/discord' });
  res.json({
    user: publicUser(req.user),
    site: SITE,
    suspended: !!req.user.suspended,
    staff: isStaff(req.user.role),
  });
});

apiRouter.get('/meta', requireStaff, (req, res) => {
  const myRank = rankOf(req.user.role);
  res.json({
    site: SITE,
    roles: publicRoleList(),
    assignable: assignableRoles(req.user.role),
    channels: db
      .prepare('SELECT key, name, topic, min_rank FROM chat_channels ORDER BY position ASC')
      .all()
      .filter((c) => myRank >= c.min_rank)
      .map((c) => ({ key: c.key, name: c.name, topic: c.topic, minRank: c.min_rank })),
    roblox: { placeId: config.roblox.placeId, universeId: config.roblox.universeId },
  });
});

/**
 * Link your own Roblox account. Deliberately above the staff gate: a banned
 * player needs this before they can file an appeal.
 */
apiRouter.post('/me/roblox', requireLogin, (req, res) => {
  const robloxId = int(req.body?.robloxId);
  const username = text(req.body?.username, 60);
  db.prepare('UPDATE users SET roblox_user_id = ?, roblox_username = ? WHERE id = ?').run(
    robloxId || null,
    username,
    req.user.id
  );
  audit(req.user, 'account.link_roblox', `user:${req.user.id}`, String(robloxId || ''), clientIp(req));
  res.json({ ok: true });
});

// Everything past this point is staff-only.
apiRouter.use(requireStaff);

// ---------------------------------------------------------------
// live stats
// ---------------------------------------------------------------
apiRouter.get('/stats/live', requirePerm('stats.view'), (req, res) => {
  res.json({ stats: liveSnapshot(), staffOnline: onlineStaff() });
});

apiRouter.get('/stats/history', requirePerm('stats.view'), (req, res) => {
  res.json({ history: history(clamp(int(req.query.minutes, 180), 10, 1440 * 7)) });
});

apiRouter.get('/feed', requirePerm('stats.view'), (req, res) => {
  const limit = clamp(int(req.query.limit, 50), 1, 200);
  const type = text(req.query.type, 30);
  const rows = type
    ? db
        .prepare('SELECT * FROM game_events WHERE type = ? ORDER BY id DESC LIMIT ?')
        .all(type, limit)
    : db.prepare('SELECT * FROM game_events ORDER BY id DESC LIMIT ?').all(limit);
  res.json({
    events: rows.map((e) => ({
      id: e.id,
      serverId: e.server_id,
      robloxId: e.roblox_id,
      username: e.username,
      type: e.type,
      detail: e.detail,
      data: jsonOr(e.data, {}),
      at: e.created_at,
    })),
  });
});

// ---------------------------------------------------------------
// player database
// ---------------------------------------------------------------
apiRouter.get('/players', requirePerm('db.view'), (req, res) => {
  const q = text(req.query.q, 60);
  const limit = clamp(int(req.query.limit, 40), 1, 200);
  const offset = clamp(int(req.query.offset, 0), 0, 1e6);
  const filter = text(req.query.filter, 20); // banned | online | flagged | new

  const where = [];
  const params = [];
  if (q) {
    if (/^\d+$/.test(q)) {
      where.push('(p.roblox_id = ? OR p.username LIKE ?)');
      params.push(Number(q), `%${q}%`);
    } else {
      where.push('(p.username LIKE ? COLLATE NOCASE OR p.display_name LIKE ? COLLATE NOCASE)');
      params.push(`%${q}%`, `%${q}%`);
    }
  }
  if (filter === 'banned') {
    where.push("EXISTS (SELECT 1 FROM punishments x WHERE x.roblox_id = p.roblox_id AND x.type='ban' AND x.active=1)");
  } else if (filter === 'online') {
    where.push('EXISTS (SELECT 1 FROM server_players sp WHERE sp.roblox_id = p.roblox_id)');
  } else if (filter === 'flagged') {
    where.push("p.flags != '[]'");
  } else if (filter === 'new') {
    where.push('p.first_seen_at > ?');
    params.push(now() - 7 * 864e5);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  expirePunishments();

  const total = db.prepare(`SELECT COUNT(*) AS n FROM players p ${clause}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM punishments x WHERE x.roblox_id = p.roblox_id) AS punish_count,
         (SELECT COUNT(*) FROM punishments x WHERE x.roblox_id = p.roblox_id AND x.type='ban' AND x.active=1) AS banned,
         (SELECT server_id FROM server_players sp WHERE sp.roblox_id = p.roblox_id LIMIT 1) AS online_server
       FROM players p ${clause}
       ORDER BY p.last_seen_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  res.json({ total, limit, offset, players: rows.map(shapePlayerRow) });
});

function shapePlayerRow(p) {
  return {
    robloxId: p.roblox_id,
    username: p.username,
    displayName: p.display_name,
    avatar: headshot(p.roblox_id),
    accountAgeDays: p.account_age_days,
    firstSeen: p.first_seen_at,
    lastSeen: p.last_seen_at,
    playtime: p.playtime_seconds,
    joins: p.join_count,
    level: p.level,
    cash: p.cash,
    kills: p.kills,
    deaths: p.deaths,
    crew: p.crew,
    device: p.device,
    flags: jsonOr(p.flags, []),
    punishments: p.punish_count ?? 0,
    banned: !!p.banned,
    onlineServer: p.online_server || null,
  };
}

apiRouter.get('/players/:id', requirePerm('db.view'), (req, res) => {
  const id = int(req.params.id);
  const p = db.prepare('SELECT * FROM players WHERE roblox_id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'player_not_found' });

  const presence = db.prepare('SELECT * FROM server_players WHERE roblox_id = ?').get(id);
  const notes = db
    .prepare('SELECT * FROM player_notes WHERE roblox_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(id);
  const events = db
    .prepare('SELECT * FROM game_events WHERE roblox_id = ? ORDER BY id DESC LIMIT 60')
    .all(id);
  const names = db.prepare('SELECT username, seen_at FROM player_names WHERE roblox_id = ?').all(id);

  // Same last-known IP hash = very likely the same person on another account.
  const alts = p.last_ip_hash
    ? db
        .prepare('SELECT roblox_id, username, last_seen_at FROM players WHERE last_ip_hash = ? AND roblox_id != ? LIMIT 25')
        .all(p.last_ip_hash, id)
    : [];

  res.json({
    player: {
      ...shapePlayerRow(p),
      robberies: p.robberies,
      arrests: p.arrests,
      data: jsonOr(p.data, {}),
      lastServerId: p.last_server_id,
      profileUrl: `https://www.roblox.com/users/${id}/profile`,
    },
    online: presence ? { serverId: presence.server_id, team: presence.team, joinedAt: presence.joined_at } : null,
    activeBan: shapePunishment(activeBan(id)),
    punishments: punishmentsFor(id).map(shapePunishment),
    notes: notes.map((n) => ({
      id: n.id,
      body: n.body,
      author: n.author_name,
      authorRole: n.author_role,
      authorRoleName: n.author_role ? roleInfo(n.author_role).name : null,
      authorRoleColor: n.author_role ? roleInfo(n.author_role).color : null,
      at: n.created_at,
    })),
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      detail: e.detail,
      serverId: e.server_id,
      at: e.created_at,
    })),
    knownNames: names.map((n) => n.username),
    possibleAlts: alts.map((a) => ({ robloxId: a.roblox_id, username: a.username, lastSeen: a.last_seen_at })),
  });
});

apiRouter.post('/players/:id/notes', requirePerm('db.note'), (req, res) => {
  const id = int(req.params.id);
  const body = text(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'body_required' });
  const info = db
    .prepare(
      `INSERT INTO player_notes (roblox_id, body, author_id, author_name, author_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, body, req.user.id, req.user.discord_username, req.user.role, now());
  audit(req.user, 'player.note', `player:${id}`, body.slice(0, 120), clientIp(req));
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

apiRouter.post('/players/:id/flags', requirePerm('punish.warn'), (req, res) => {
  const id = int(req.params.id);
  const flags = Array.isArray(req.body?.flags) ? req.body.flags.map((f) => String(f).slice(0, 30)).slice(0, 20) : [];
  const info = db.prepare('UPDATE players SET flags = ? WHERE roblox_id = ?').run(JSON.stringify(flags), id);
  if (!info.changes) return res.status(404).json({ error: 'player_not_found' });
  audit(req.user, 'player.flags', `player:${id}`, flags.join(','), clientIp(req));
  res.json({ ok: true, flags });
});

// ---------------------------------------------------------------
// punishments
// ---------------------------------------------------------------
const PERM_FOR_TYPE = { warn: 'punish.warn', mute: 'punish.mute', kick: 'punish.kick' };

apiRouter.post('/players/:id/punish', (req, res) => {
  const id = int(req.params.id);
  const type = text(req.body?.type, 10);
  const reason = text(req.body?.reason, 500);
  if (!['warn', 'mute', 'kick', 'ban'].includes(type)) return res.status(400).json({ error: 'bad_type' });
  if (!reason) return res.status(400).json({ error: 'reason_required' });

  const durationMs = parseDuration(req.body?.duration);

  // Bans split by permanence: a permanent ban needs a higher rank.
  let permission;
  if (type === 'ban') permission = durationMs === null ? 'punish.ban.perm' : 'punish.ban.temp';
  else permission = PERM_FOR_TYPE[type];
  if (!can(req.user.role, permission)) {
    return res.status(403).json({ error: 'missing_permission', permission });
  }

  // Never let staff punish someone who outranks them on the site.
  const targetStaff = db.prepare('SELECT role FROM users WHERE roblox_user_id = ?').get(id);
  if (targetStaff && !outranks(req.user.role, targetStaff.role)) {
    return res.status(403).json({ error: 'target_outranks_you', targetRole: targetStaff.role });
  }

  const known = db.prepare('SELECT username FROM players WHERE roblox_id = ?').get(id);
  const username = text(req.body?.username, 60) || known?.username || `user_${id}`;
  if (!known) {
    // Pre-register the player so an offline ban still lands on a real row.
    const t = now();
    db.prepare(
      'INSERT OR IGNORE INTO players (roblox_id, username, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)'
    ).run(id, username, t, t);
  }

  const punishment = issuePunishment({
    robloxId: id,
    username,
    type,
    reason,
    evidence: text(req.body?.evidence, 500),
    durationMs,
    actor: req.user,
    source: 'panel',
  });

  res.json({ ok: true, punishment: shapePunishment(punishment) });
});

apiRouter.get('/punishments', requirePerm('db.view'), (req, res) => {
  expirePunishments();
  const limit = clamp(int(req.query.limit, 50), 1, 200);
  const offset = clamp(int(req.query.offset, 0), 0, 1e6);
  const type = text(req.query.type, 10);
  const q = text(req.query.q, 60);
  const activeOnly = req.query.active === '1';

  const where = [];
  const params = [];
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (activeOnly) where.push('active = 1');
  if (q) {
    where.push('(username LIKE ? COLLATE NOCASE OR CAST(roblox_id AS TEXT) LIKE ? OR reason LIKE ? COLLATE NOCASE)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  // Without punish.viewAll a staff member only sees their own casework.
  if (!can(req.user.role, 'punish.viewAll')) {
    where.push('issued_by = ?');
    params.push(req.user.id);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM punishments ${clause}`).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM punishments ${clause} ORDER BY issued_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  res.json({ total, punishments: rows.map(shapePunishment) });
});

apiRouter.post('/punishments/:id/revoke', requirePerm('punish.revoke'), (req, res) => {
  const result = revokePunishment(int(req.params.id), req.user, text(req.body?.reason, 300));
  if (result.error) {
    const status = result.error === 'not_found' ? 404 : 403;
    return res.status(status).json(result);
  }
  res.json({ ok: true, punishment: shapePunishment(result.punishment) });
});

// ---------------------------------------------------------------
// appeals
// ---------------------------------------------------------------
apiRouter.get('/appeals', requirePerm('appeals.review'), (req, res) => {
  const status = text(req.query.status, 12) || 'pending';
  const rows = db
    .prepare(
      `SELECT a.*, p.reason AS ban_reason, p.type AS ban_type, p.expires_at, p.username
         FROM appeals a JOIN punishments p ON p.id = a.punishment_id
        WHERE a.status = ? ORDER BY a.created_at DESC LIMIT 200`
    )
    .all(status);
  res.json({
    appeals: rows.map((a) => ({
      id: a.id,
      punishmentId: a.punishment_id,
      robloxId: a.roblox_id,
      username: a.username,
      avatar: headshot(a.roblox_id),
      body: a.body,
      status: a.status,
      createdAt: a.created_at,
      banReason: a.ban_reason,
      banType: a.ban_type,
      expiresAt: a.expires_at,
      handledBy: a.handled_by_name,
      response: a.response,
    })),
  });
});

apiRouter.post('/appeals/:id', requirePerm('appeals.review'), (req, res) => {
  const id = int(req.params.id);
  const decision = text(req.body?.decision, 10);
  if (!['accepted', 'denied'].includes(decision)) return res.status(400).json({ error: 'bad_decision' });

  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(id);
  if (!appeal) return res.status(404).json({ error: 'not_found' });
  if (appeal.status !== 'pending') return res.status(409).json({ error: 'already_handled' });

  db.prepare(
    'UPDATE appeals SET status = ?, handled_by = ?, handled_by_name = ?, handled_at = ?, response = ? WHERE id = ?'
  ).run(decision, req.user.id, req.user.discord_username, now(), text(req.body?.response, 1000), id);

  if (decision === 'accepted') {
    const r = revokePunishment(appeal.punishment_id, req.user, 'Appeal accepted');
    if (r.error === 'outranked') {
      return res.status(403).json({ error: 'outranked_cannot_lift', detail: r });
    }
  }

  audit(req.user, `appeal.${decision}`, `appeal:${id}`, null, clientIp(req));
  broadcast({ type: 'appeal_handled', id, decision, by: req.user.discord_username }, 30);
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// live servers + who is in them
// ---------------------------------------------------------------
apiRouter.get('/servers', requirePerm('servers.view'), (req, res) => {
  reapDeadServers();
  const includeOffline = req.query.all === '1';
  const rows = includeOffline
    ? db.prepare('SELECT * FROM servers ORDER BY status ASC, player_count DESC LIMIT 300').all()
    : db.prepare("SELECT * FROM servers WHERE status = 'online' ORDER BY player_count DESC LIMIT 300").all();
  res.json({ servers: rows.map(shapeServer) });
});

function shapeServer(s) {
  return {
    id: s.id,
    placeId: s.place_id,
    region: s.region,
    players: s.player_count,
    maxPlayers: s.max_players,
    uptime: s.uptime_seconds,
    fps: s.fps,
    ping: s.ping,
    memory: s.memory_mb,
    version: s.version,
    startedAt: s.started_at,
    lastBeat: s.last_beat_at,
    status: s.status,
    stale: now() - s.last_beat_at > config.serverTimeoutMs,
  };
}

/** The "look up a server by its ID" feature. */
apiRouter.get('/servers/:id', requirePerm('servers.view'), (req, res) => {
  reapDeadServers();
  const id = String(req.params.id).trim();
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!server) return res.status(404).json({ error: 'server_not_found', serverId: id });

  const roster = db
    .prepare(
      `SELECT sp.*, p.level, p.cash, p.account_age_days, p.playtime_seconds, p.flags,
              (SELECT COUNT(*) FROM punishments x WHERE x.roblox_id = sp.roblox_id) AS punish_count,
              (SELECT COUNT(*) FROM punishments x WHERE x.roblox_id = sp.roblox_id AND x.active = 1 AND x.type='ban') AS banned
         FROM server_players sp
         LEFT JOIN players p ON p.roblox_id = sp.roblox_id
        WHERE sp.server_id = ?
        ORDER BY sp.joined_at ASC`
    )
    .all(id);

  const recent = db
    .prepare('SELECT * FROM game_events WHERE server_id = ? ORDER BY id DESC LIMIT 40')
    .all(id);

  res.json({
    server: shapeServer(server),
    players: roster.map((r) => ({
      robloxId: r.roblox_id,
      username: r.username,
      displayName: r.display_name,
      avatar: headshot(r.roblox_id),
      team: r.team,
      joinedAt: r.joined_at,
      level: r.level ?? 1,
      cash: r.cash ?? 0,
      accountAgeDays: r.account_age_days ?? 0,
      playtime: r.playtime_seconds ?? 0,
      flags: jsonOr(r.flags, []),
      punishments: r.punish_count ?? 0,
      banned: !!r.banned,
      profileUrl: `https://www.roblox.com/users/${r.roblox_id}/profile`,
    })),
    events: recent.map((e) => ({
      id: e.id,
      type: e.type,
      username: e.username,
      detail: e.detail,
      at: e.created_at,
    })),
  });
});

apiRouter.post('/servers/:id/message', requirePerm('punish.warn'), (req, res) => {
  const body = text(req.body?.message, 300);
  if (!body) return res.status(400).json({ error: 'message_required' });
  const id = queueAction({
    serverId: String(req.params.id),
    type: 'message',
    payload: { message: body, from: req.user.discord_username, role: roleInfo(req.user.role).name },
    actor: req.user,
  });
  audit(req.user, 'server.message', `server:${req.params.id}`, body, clientIp(req));
  res.json({ ok: true, actionId: id });
});

apiRouter.post('/servers/:id/shutdown', requirePerm('servers.shutdown'), (req, res) => {
  const id = queueAction({
    serverId: String(req.params.id),
    type: 'shutdown',
    payload: { reason: text(req.body?.reason, 200) || 'Shut down by staff', by: req.user.discord_username },
    actor: req.user,
  });
  audit(req.user, 'server.shutdown', `server:${req.params.id}`, req.body?.reason ?? null, clientIp(req));
  broadcast({ type: 'server_shutdown', serverId: req.params.id, by: req.user.discord_username }, 40);
  res.json({ ok: true, actionId: id });
});

// ---------------------------------------------------------------
// staff chat
// ---------------------------------------------------------------
function channelFor(req, key) {
  const ch = db.prepare('SELECT * FROM chat_channels WHERE key = ?').get(key);
  if (!ch) return { error: 'channel_not_found' };
  if (rankOf(req.user.role) < ch.min_rank) return { error: 'channel_forbidden', minRank: ch.min_rank };
  return { channel: ch };
}

apiRouter.get('/chat/:channel/messages', requirePerm('chat.read'), (req, res) => {
  const found = channelFor(req, req.params.channel);
  if (found.error) return res.status(found.error === 'channel_not_found' ? 404 : 403).json(found);

  const before = int(req.query.before, 0);
  const limit = clamp(int(req.query.limit, 60), 1, 200);
  const rows = before
    ? db
        .prepare('SELECT * FROM chat_messages WHERE channel = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(found.channel.key, before, limit)
    : db
        .prepare('SELECT * FROM chat_messages WHERE channel = ? ORDER BY id DESC LIMIT ?')
        .all(found.channel.key, limit);

  res.json({
    channel: { key: found.channel.key, name: found.channel.name, topic: found.channel.topic },
    messages: rows.reverse().map(shapeMessage),
  });
});

function shapeMessage(m) {
  const r = roleInfo(m.author_role);
  return {
    id: m.id,
    channel: m.channel,
    userId: m.user_id,
    author: m.author_name,
    authorRole: m.author_role,
    roleName: r.name,
    roleColor: r.color,
    avatar: m.author_avatar,
    body: m.deleted_at ? null : m.body,
    deleted: !!m.deleted_at,
    deletedBy: m.deleted_by,
    at: m.created_at,
  };
}

const chatRate = new Map();

apiRouter.post('/chat/:channel/messages', requirePerm('chat.write'), (req, res) => {
  const found = channelFor(req, req.params.channel);
  if (found.error) return res.status(found.error === 'channel_not_found' ? 404 : 403).json(found);

  const body = text(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'body_required' });

  // 5 messages per 5 seconds, per user.
  const t = now();
  const bucket = chatRate.get(req.user.id) || [];
  const recent = bucket.filter((x) => t - x < 5000);
  if (recent.length >= 5) return res.status(429).json({ error: 'slow_down' });
  recent.push(t);
  chatRate.set(req.user.id, recent);

  const info = db
    .prepare(
      `INSERT INTO chat_messages (channel, user_id, author_name, author_role, author_avatar, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      found.channel.key,
      req.user.id,
      req.user.discord_global || req.user.discord_username,
      req.user.role,
      avatarUrl(req.user),
      body,
      t
    );

  const message = shapeMessage(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(info.lastInsertRowid)));
  broadcast({ type: 'chat', message }, found.channel.min_rank);
  res.json({ ok: true, message });
});

apiRouter.delete('/chat/messages/:id', requirePerm('chat.delete'), (req, res) => {
  const id = int(req.params.id);
  const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id);
  if (!msg) return res.status(404).json({ error: 'not_found' });
  // You may always delete your own; deleting someone else's needs to outrank them.
  if (msg.user_id !== req.user.id && !outranks(req.user.role, msg.author_role)) {
    return res.status(403).json({ error: 'outranked' });
  }
  db.prepare('UPDATE chat_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(
    now(),
    req.user.discord_username,
    id
  );
  audit(req.user, 'chat.delete', `message:${id}`, msg.body.slice(0, 120), clientIp(req));
  const ch = db.prepare('SELECT min_rank FROM chat_channels WHERE key = ?').get(msg.channel);
  broadcast({ type: 'chat_deleted', id, channel: msg.channel, by: req.user.discord_username }, ch?.min_rank ?? 10);
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// staff management
// ---------------------------------------------------------------
apiRouter.get('/staff', requirePerm('staff.view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY role, discord_username').all();
  const online = new Set(onlineStaff().map((s) => s.id));
  const staff = rows
    .map((u) => ({ ...publicUser(u), status: u.status, online: online.has(u.id), createdAt: u.created_at }))
    .sort((a, b) => b.rank - a.rank || a.username.localeCompare(b.username));
  res.json({
    staff: staff.filter((s) => s.staff),
    members: staff.filter((s) => !s.staff),
    assignable: assignableRoles(req.user.role),
  });
});

apiRouter.post('/staff/:userId/role', requirePerm('staff.manage'), (req, res) => {
  const targetId = int(req.params.userId);
  const newRole = text(req.body?.role, 30);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });
  if (!publicRoleList().some((r) => r.key === newRole)) return res.status(400).json({ error: 'bad_role' });

  if (target.id === req.user.id) return res.status(403).json({ error: 'cannot_change_own_role' });

  // Game Owner is granted by OWNER_DISCORD_ID alone. No API path assigns it,
  // and no API path takes it away either.
  if (newRole === 'game_owner') {
    audit(req.user, 'security.owner_grant_blocked', `user:${targetId}`, null, clientIp(req));
    return res.status(403).json({ error: 'owner_role_is_env_only' });
  }
  if (target.role === 'game_owner') {
    return res.status(403).json({ error: 'cannot_change_owner' });
  }
  // You may only act on people below you, and only hand out roles below you.
  if (!outranks(req.user.role, target.role)) {
    return res.status(403).json({ error: 'target_outranks_you', targetRole: target.role });
  }
  if (!assignableRoles(req.user.role).includes(newRole)) {
    return res.status(403).json({ error: 'role_above_you', role: newRole });
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, targetId);
  audit(req.user, 'staff.role_change', `user:${targetId}`, `${target.role} -> ${newRole}`, clientIp(req));
  broadcast(
    {
      type: 'staff_update',
      user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(targetId)),
      by: req.user.discord_username,
      from: target.role,
      to: newRole,
    },
    10
  );
  res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(targetId)) });
});

apiRouter.post('/staff/:userId/status', requirePerm('staff.remove'), (req, res) => {
  const targetId = int(req.params.userId);
  const status = text(req.body?.status, 12);
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });
  if (target.id === req.user.id) return res.status(403).json({ error: 'cannot_suspend_yourself' });
  if (!outranks(req.user.role, target.role)) return res.status(403).json({ error: 'target_outranks_you' });

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, targetId);
  if (status === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
  audit(req.user, `staff.${status}`, `user:${targetId}`, null, clientIp(req));
  res.json({ ok: true });
});

apiRouter.post('/staff/:userId/roblox', requirePerm('staff.manage'), (req, res) => {
  const targetId = int(req.params.userId);
  const robloxId = int(req.body?.robloxId);
  const username = text(req.body?.username, 60);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });
  if (target.id !== req.user.id && !outranks(req.user.role, target.role)) {
    return res.status(403).json({ error: 'target_outranks_you' });
  }
  db.prepare('UPDATE users SET roblox_user_id = ?, roblox_username = ? WHERE id = ?').run(
    robloxId || null,
    username,
    targetId
  );
  audit(req.user, 'staff.link_roblox', `user:${targetId}`, `${robloxId} ${username ?? ''}`, clientIp(req));
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// API keys (the game's credentials)
// ---------------------------------------------------------------
apiRouter.get('/apikeys', requirePerm('apikeys.view'), (req, res) => {
  res.json({ keys: listKeys(), endpoint: `${config.baseUrl}/api/game` });
});

apiRouter.post('/apikeys', requirePerm('apikeys.manage'), (req, res) => {
  const label = text(req.body?.label, 60);
  if (!label) return res.status(400).json({ error: 'label_required' });
  const created = createKey({ label, scopes: 'game', actor: req.user });
  // `created.key` is returned exactly once and never stored in plaintext.
  res.json({ ok: true, key: created });
});

apiRouter.delete('/apikeys/:id', requirePerm('apikeys.manage'), (req, res) => {
  const ok = revokeKey(int(req.params.id), req.user);
  res.json({ ok });
});

// ---------------------------------------------------------------
// whitelist - who is allowed to sign in at all
// ---------------------------------------------------------------
apiRouter.get('/whitelist', requirePerm('whitelist.view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM whitelist ORDER BY added_at DESC').all();
  const linked = db.prepare('SELECT discord_id, discord_username, role, status FROM users').all();
  const byId = Object.fromEntries(linked.map((u) => [u.discord_id, u]));

  res.json({
    enabled: isWhitelistEnabled(),
    ownerId: config.discord.ownerId || null,
    guildLock: config.discord.guildId || null,
    entries: rows.map((w) => ({
      discordId: w.discord_id,
      label: w.label,
      note: w.note,
      addedBy: w.added_by_name,
      addedAt: w.added_at,
      hasLoggedIn: !!byId[w.discord_id],
      username: byId[w.discord_id]?.discord_username ?? null,
      role: byId[w.discord_id]?.role ?? null,
      roleName: byId[w.discord_id] ? roleInfo(byId[w.discord_id].role).name : null,
      status: byId[w.discord_id]?.status ?? null,
    })),
  });
});

apiRouter.post('/whitelist', requirePerm('whitelist.manage'), (req, res) => {
  const discordId = text(req.body?.discordId, 24);
  if (!discordId || !/^\d{17,20}$/.test(discordId)) {
    return res.status(400).json({ error: 'bad_discord_id' });
  }
  db.prepare(
    `INSERT INTO whitelist (discord_id, label, note, added_by, added_by_name, added_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET label = excluded.label, note = excluded.note`
  ).run(
    discordId,
    text(req.body?.label, 60),
    text(req.body?.note, 300),
    req.user.id,
    req.user.discord_username,
    now()
  );
  audit(req.user, 'whitelist.add', `discord:${discordId}`, text(req.body?.label, 60), clientIp(req));
  res.json({ ok: true });
});

apiRouter.delete('/whitelist/:discordId', requirePerm('whitelist.manage'), (req, res) => {
  const discordId = String(req.params.discordId);

  if (config.discord.ownerId && discordId === config.discord.ownerId) {
    return res.status(403).json({ error: 'cannot_remove_owner' });
  }

  // You cannot revoke access from somebody who outranks you.
  const target = db.prepare('SELECT role FROM users WHERE discord_id = ?').get(discordId);
  if (target && !outranks(req.user.role, target.role)) {
    return res.status(403).json({ error: 'target_outranks_you', targetRole: target.role });
  }

  const info = db.prepare('DELETE FROM whitelist WHERE discord_id = ?').run(discordId);

  // Removing someone from the whitelist ends their session immediately.
  if (req.query.revoke !== '0' && target) {
    const user = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId);
    if (user) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  }

  audit(req.user, 'whitelist.remove', `discord:${discordId}`, null, clientIp(req));
  res.json({ ok: true, removed: info.changes > 0 });
});

apiRouter.post('/whitelist/enabled', requirePerm('settings.manage'), (req, res) => {
  const enabled = req.body?.enabled === true || req.body?.enabled === '1';
  setSetting('whitelist_enabled', enabled ? '1' : '0', req.user);
  audit(req.user, 'settings.whitelist_enabled', null, enabled ? 'on' : 'off', clientIp(req));
  res.json({ ok: true, enabled });
});

// ---------------------------------------------------------------
// role renaming - Game Owner only, cosmetic only
// ---------------------------------------------------------------
apiRouter.post('/roles/:key', requirePerm('roles.rename'), (req, res) => {
  const result = setRoleAppearance(
    String(req.params.key),
    { name: req.body?.name, color: req.body?.color },
    req.user
  );
  if (result.error) return res.status(400).json(result);
  audit(req.user, 'roles.rename', `role:${req.params.key}`, `${req.body?.name ?? ''} ${req.body?.color ?? ''}`.trim(), clientIp(req));
  broadcast({ type: 'roles_changed', roles: publicRoleList() }, 0);
  res.json({ ok: true, role: result.role, roles: publicRoleList() });
});

apiRouter.delete('/roles/:key', requirePerm('roles.rename'), (req, res) => {
  const result = resetRoleAppearance(String(req.params.key));
  if (result.error) return res.status(400).json(result);
  audit(req.user, 'roles.reset', `role:${req.params.key}`, null, clientIp(req));
  broadcast({ type: 'roles_changed', roles: publicRoleList() }, 0);
  res.json({ ok: true, role: result.role, roles: publicRoleList() });
});

// ---------------------------------------------------------------
// security overview
// ---------------------------------------------------------------
apiRouter.get('/security', requirePerm('security.view'), (req, res) => {
  const t = now();
  const dayAgo = t - 864e5;

  const rejected = db
    .prepare('SELECT * FROM login_attempts WHERE created_at > ? ORDER BY id DESC LIMIT 100')
    .all(t - 7 * 864e5);

  const sessions = db
    .prepare(
      `SELECT s.id, s.created_at, s.last_used_at, s.ip, s.user_agent, u.discord_username, u.role, u.id AS user_id
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > ? ORDER BY s.last_used_at DESC LIMIT 100`
    )
    .all(t);

  const owners = db.prepare("SELECT discord_id, discord_username FROM users WHERE role = 'game_owner'").all();

  res.json({
    config: auditConfiguration(),
    whitelistEnabled: isWhitelistEnabled(),
    whitelistCount: db.prepare('SELECT COUNT(*) AS n FROM whitelist').get().n,
    guildLock: config.discord.guildId || null,
    ownerConfigured: !!config.discord.ownerId,
    owners: owners.map((o) => ({ discordId: o.discord_id, username: o.discord_username })),
    rejected24h: db
      .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE created_at > ?')
      .get(dayAgo).n,
    rejectedLogins: rejected.map((r) => ({
      id: r.id,
      discordId: r.discord_id,
      username: r.username,
      ip: r.ip,
      reason: r.reason,
      at: r.created_at,
    })),
    sessions: sessions.map((s) => ({
      id: s.id.slice(0, 8),
      userId: s.user_id,
      username: s.discord_username,
      role: s.role,
      roleName: roleInfo(s.role).name,
      ip: s.ip,
      device: shortenAgent(s.user_agent),
      createdAt: s.created_at,
      lastUsed: s.last_used_at,
      isYou: s.id === req.user.sid,
    })),
  });
});

apiRouter.post('/security/sessions/revoke', requirePerm('staff.remove'), (req, res) => {
  const userId = int(req.body?.userId);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });
  if (target.id !== req.user.id && !outranks(req.user.role, target.role)) {
    return res.status(403).json({ error: 'target_outranks_you' });
  }
  const info = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  audit(req.user, 'security.sessions_revoked', `user:${userId}`, `${info.changes} session(s)`, clientIp(req));
  res.json({ ok: true, revoked: info.changes });
});

function shortenAgent(ua) {
  if (!ua) return 'unknown';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return ua.slice(0, 40);
}

// ---------------------------------------------------------------
// audit log
// ---------------------------------------------------------------
apiRouter.get('/audit', requirePerm('audit.view'), (req, res) => {
  const limit = clamp(int(req.query.limit, 100), 1, 500);
  const q = text(req.query.q, 60);
  const rows = q
    ? db
        .prepare(
          `SELECT * FROM audit_log
            WHERE action LIKE ? OR actor_name LIKE ? OR target LIKE ?
            ORDER BY id DESC LIMIT ?`
        )
        .all(`%${q}%`, `%${q}%`, `%${q}%`, limit)
    : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json({
    entries: rows.map((a) => ({
      id: a.id,
      actor: a.actor_name,
      actorRole: a.actor_role,
      roleName: a.actor_role ? roleInfo(a.actor_role).name : null,
      roleColor: a.actor_role ? roleInfo(a.actor_role).color : null,
      action: a.action,
      target: a.target,
      detail: a.detail,
      at: a.created_at,
    })),
  });
});

import express from 'express';
import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { requireApiKey } from '../apikeys.js';
import { broadcast } from '../realtime.js';
import {
  activeBan,
  activeMute,
  issuePunishment,
  takeActions,
  ackActions,
  parseDuration,
  shapePunishment,
} from '../moderation.js';

export const gameRouter = express.Router();
gameRouter.use(requireApiKey('game'));

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v, max = 200) => (v == null ? null : String(v).slice(0, max));

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip) + config.sessionSecret).digest('hex').slice(0, 32);
}

/** Create or refresh a row in the player database. */
function upsertPlayer(p, serverId) {
  const t = now();
  const id = num(p.userId ?? p.robloxId ?? p.id);
  if (!id) return null;
  const username = str(p.username ?? p.name, 60) || `user_${id}`;

  const existing = db.prepare('SELECT roblox_id FROM players WHERE roblox_id = ?').get(id);
  if (!existing) {
    db.prepare(
      `INSERT INTO players (roblox_id, username, display_name, account_age_days, first_seen_at, last_seen_at,
                            join_count, last_server_id, last_ip_hash, device)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(
      id,
      username,
      str(p.displayName, 60),
      num(p.accountAge),
      t,
      t,
      serverId || null,
      hashIp(p.ip),
      str(p.device, 30)
    );
  } else {
    db.prepare(
      `UPDATE players SET username = ?, display_name = COALESCE(?, display_name),
              account_age_days = MAX(account_age_days, ?), last_seen_at = ?,
              last_server_id = COALESCE(?, last_server_id),
              last_ip_hash = COALESCE(?, last_ip_hash),
              device = COALESCE(?, device)
        WHERE roblox_id = ?`
    ).run(
      username,
      str(p.displayName, 60),
      num(p.accountAge),
      t,
      serverId || null,
      hashIp(p.ip),
      str(p.device, 30),
      id
    );
  }

  db.prepare('INSERT OR IGNORE INTO player_names (roblox_id, username, seen_at) VALUES (?, ?, ?)').run(id, username, t);

  // Optional gameplay stats the game may push along with the player.
  const s = p.stats || {};
  if (Object.keys(s).length) {
    db.prepare(
      `UPDATE players SET cash = ?, level = ?, kills = ?, deaths = ?, robberies = ?, arrests = ?,
              crew = COALESCE(?, crew), playtime_seconds = MAX(playtime_seconds, ?), data = ?
        WHERE roblox_id = ?`
    ).run(
      num(s.cash),
      num(s.level, 1),
      num(s.kills),
      num(s.deaths),
      num(s.robberies),
      num(s.arrests),
      str(s.crew, 40),
      num(s.playtime),
      JSON.stringify(p.data || {}),
      id
    );
  }
  return id;
}

function logEvent({ serverId, robloxId, username, type, detail, data }) {
  db.prepare(
    `INSERT INTO game_events (server_id, roblox_id, username, type, detail, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(serverId || null, robloxId || null, username || null, type, str(detail, 500), JSON.stringify(data || {}), now());
}

// ---------------------------------------------------------------
// GET /api/game/ping - key smoke test from Studio
// ---------------------------------------------------------------
gameRouter.get('/ping', (req, res) => {
  res.json({ ok: true, site: 'Zah Hood Central', key: req.apiKey.label, serverTime: now() });
});

// ---------------------------------------------------------------
// POST /api/game/heartbeat
// The game sends this every ~15s. It is also the delivery channel for
// queued moderation actions, so one round trip keeps everything in sync.
// ---------------------------------------------------------------
gameRouter.post('/heartbeat', (req, res) => {
  const b = req.body || {};
  const serverId = str(b.serverId ?? b.jobId, 100);
  if (!serverId) return res.status(400).json({ ok: false, error: 'serverId_required' });

  const t = now();
  const players = Array.isArray(b.players) ? b.players : [];

  db.prepare(
    `INSERT INTO servers (id, place_id, region, player_count, max_players, uptime_seconds,
                          fps, ping, memory_mb, version, started_at, last_beat_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online')
     ON CONFLICT(id) DO UPDATE SET
       place_id = excluded.place_id,
       region = COALESCE(excluded.region, servers.region),
       player_count = excluded.player_count,
       max_players = excluded.max_players,
       uptime_seconds = excluded.uptime_seconds,
       fps = excluded.fps, ping = excluded.ping, memory_mb = excluded.memory_mb,
       version = excluded.version, last_beat_at = excluded.last_beat_at, status = 'online'`
  ).run(
    serverId,
    str(b.placeId ?? config.roblox.placeId, 40),
    str(b.region, 40),
    players.length || num(b.playerCount),
    num(b.maxPlayers),
    num(b.uptime),
    b.fps != null ? num(b.fps) : null,
    b.ping != null ? num(b.ping) : null,
    b.memory != null ? num(b.memory) : null,
    str(b.version, 40),
    t - num(b.uptime) * 1000,
    t
  );

  // Rebuild this server's roster from the heartbeat - it is the source of truth.
  const seen = new Set();
  const upsertPresence = db.prepare(
    `INSERT INTO server_players (server_id, roblox_id, username, display_name, team, joined_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, roblox_id) DO UPDATE SET
       username = excluded.username, display_name = excluded.display_name,
       team = excluded.team, updated_at = excluded.updated_at`
  );
  for (const p of players) {
    const id = upsertPlayer(p, serverId);
    if (!id) continue;
    seen.add(id);
    upsertPresence.run(serverId, id, str(p.username ?? p.name, 60) || `user_${id}`, str(p.displayName, 60), str(p.team, 40), t, t);
  }
  const stale = db.prepare('SELECT roblox_id FROM server_players WHERE server_id = ?').all(serverId);
  const drop = db.prepare('DELETE FROM server_players WHERE server_id = ? AND roblox_id = ?');
  for (const row of stale) if (!seen.has(row.roblox_id)) drop.run(serverId, row.roblox_id);

  const actions = takeActions(serverId);
  broadcast({ type: 'server_beat', serverId, players: players.length, at: t }, 10);

  res.json({ ok: true, serverTime: t, actions, nextBeatIn: 15 });
});

// ---------------------------------------------------------------
// POST /api/game/join
// Call this from PlayerAdded BEFORE letting the player in. The reply tells
// the game whether to kick them and why.
// ---------------------------------------------------------------
gameRouter.post('/join', (req, res) => {
  const b = req.body || {};
  const serverId = str(b.serverId ?? b.jobId, 100);
  const player = b.player || b;
  const id = upsertPlayer(player, serverId);
  if (!id) return res.status(400).json({ ok: false, error: 'userId_required' });

  const username = str(player.username ?? player.name, 60) || `user_${id}`;
  db.prepare('UPDATE players SET join_count = join_count + 1 WHERE roblox_id = ?').run(id);
  logEvent({ serverId, robloxId: id, username, type: 'join', detail: str(player.device, 30) });

  const ban = activeBan(id);
  const mute = activeMute(id);

  if (ban) {
    db.prepare('UPDATE punishments SET delivered = 1 WHERE id = ?').run(ban.id);
  }

  const record = db.prepare('SELECT * FROM players WHERE roblox_id = ?').get(id);
  const priors = db
    .prepare('SELECT type, COUNT(*) AS n FROM punishments WHERE roblox_id = ? GROUP BY type')
    .all(id);

  broadcast({ type: 'player_join', serverId, player: { robloxId: id, username }, banned: !!ban }, 10);

  res.json({
    ok: true,
    allowed: !ban,
    banned: !!ban,
    ban: ban
      ? {
          id: ban.id,
          reason: ban.reason,
          expiresAt: ban.expires_at,
          permanent: ban.expires_at === null,
          issuedBy: ban.issued_by_name,
          message: ban.expires_at
            ? `You are banned from Zah Hood until ${new Date(ban.expires_at).toUTCString()}.\nReason: ${ban.reason}\nAppeal at ${config.baseUrl}/appeal`
            : `You are permanently banned from Zah Hood.\nReason: ${ban.reason}\nAppeal at ${config.baseUrl}/appeal`,
        }
      : null,
    muted: !!mute,
    mute: mute ? { reason: mute.reason, expiresAt: mute.expires_at } : null,
    warnings: priors.find((p) => p.type === 'warn')?.n || 0,
    profile: {
      cash: record.cash,
      level: record.level,
      playtime: record.playtime_seconds,
      joinCount: record.join_count,
      flags: JSON.parse(record.flags || '[]'),
      data: JSON.parse(record.data || '{}'),
    },
  });
});

// ---------------------------------------------------------------
// POST /api/game/leave - save the player's session back to the database
// ---------------------------------------------------------------
gameRouter.post('/leave', (req, res) => {
  const b = req.body || {};
  const serverId = str(b.serverId ?? b.jobId, 100);
  const player = b.player || b;
  const id = num(player.userId ?? player.robloxId);
  if (!id) return res.status(400).json({ ok: false, error: 'userId_required' });

  upsertPlayer(player, serverId);
  const session = num(b.sessionSeconds ?? player.sessionSeconds);
  if (session > 0) {
    db.prepare('UPDATE players SET playtime_seconds = playtime_seconds + ? WHERE roblox_id = ?').run(session, id);
  }
  if (serverId) db.prepare('DELETE FROM server_players WHERE server_id = ? AND roblox_id = ?').run(serverId, id);
  logEvent({
    serverId,
    robloxId: id,
    username: str(player.username ?? player.name, 60),
    type: 'leave',
    detail: session ? `${session}s session` : null,
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------
// POST /api/game/events - batched gameplay + chat events
// ---------------------------------------------------------------
gameRouter.post('/events', (req, res) => {
  const b = req.body || {};
  const list = Array.isArray(b.events) ? b.events : [b];
  const serverId = str(b.serverId ?? b.jobId, 100);
  let stored = 0;
  for (const e of list.slice(0, 200)) {
    if (!e || !e.type) continue;
    logEvent({
      serverId: str(e.serverId, 100) || serverId,
      robloxId: num(e.userId ?? e.robloxId) || null,
      username: str(e.username, 60),
      type: str(e.type, 30),
      detail: str(e.detail ?? e.message, 500),
      data: e.data,
    });
    stored++;
  }
  broadcast({ type: 'game_events', serverId, count: stored }, 10);
  res.json({ ok: true, stored });
});

// ---------------------------------------------------------------
// POST /api/game/punish - an in-game staff member issuing a punishment
// ---------------------------------------------------------------
gameRouter.post('/punish', (req, res) => {
  const b = req.body || {};
  const id = num(b.userId ?? b.robloxId);
  if (!id) return res.status(400).json({ ok: false, error: 'userId_required' });
  const type = str(b.type, 10);
  if (!['warn', 'mute', 'kick', 'ban'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'bad_type' });
  }

  const p = issuePunishment({
    robloxId: id,
    username: str(b.username, 60) || `user_${id}`,
    type,
    reason: str(b.reason, 500) || 'No reason given',
    durationMs: parseDuration(b.duration),
    source: 'game',
    serverId: str(b.serverId ?? b.jobId, 100),
    actor: b.moderator
      ? { id: null, discord_username: `${str(b.moderator, 60)} (in-game)`, role: str(b.moderatorRole, 40) || null }
      : null,
  });

  res.json({ ok: true, punishment: shapePunishment(p) });
});

// ---------------------------------------------------------------
// GET /api/game/bans?since=<ms> - full or incremental ban sync
// ---------------------------------------------------------------
gameRouter.get('/bans', (req, res) => {
  const since = num(req.query.since, 0);
  const rows = db
    .prepare(
      `SELECT roblox_id, username, reason, expires_at, issued_at, active, issued_by_name
         FROM punishments
        WHERE type = 'ban' AND (issued_at > ? OR COALESCE(revoked_at, 0) > ?)
        ORDER BY issued_at ASC LIMIT 1000`
    )
    .all(since, since);
  res.json({
    ok: true,
    at: now(),
    bans: rows.map((r) => ({
      userId: r.roblox_id,
      username: r.username,
      reason: r.reason,
      expiresAt: r.expires_at,
      active: !!r.active,
      issuedAt: r.issued_at,
      issuedBy: r.issued_by_name,
    })),
  });
});

// ---------------------------------------------------------------
// GET /api/game/check/:userId - single lookup
// ---------------------------------------------------------------
gameRouter.get('/check/:userId', (req, res) => {
  const id = num(req.params.userId);
  const ban = activeBan(id);
  res.json({
    ok: true,
    banned: !!ban,
    reason: ban?.reason ?? null,
    expiresAt: ban?.expires_at ?? null,
  });
});

// ---------------------------------------------------------------
// POST /api/game/ack - confirm queued actions were carried out
// ---------------------------------------------------------------
gameRouter.post('/ack', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  res.json({ ok: true, acked: ackActions(ids) });
});

// ---------------------------------------------------------------
// GET /api/game/actions - pull queued actions without a heartbeat
// ---------------------------------------------------------------
gameRouter.get('/actions', (req, res) => {
  const serverId = str(req.query.serverId ?? req.query.jobId, 100);
  if (!serverId) return res.status(400).json({ ok: false, error: 'serverId_required' });
  res.json({ ok: true, actions: takeActions(serverId) });
});

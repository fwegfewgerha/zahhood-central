import { db, now, getSetting } from './db.js';
import { config } from './config.js';
import { broadcast } from './realtime.js';
import { expirePunishments } from './moderation.js';

const MINUTE = 60_000;

/** Flip servers that stopped sending heartbeats to offline and drop their roster. */
export function reapDeadServers() {
  const cutoff = now() - config.serverTimeoutMs;
  const dead = db
    .prepare("SELECT id FROM servers WHERE status = 'online' AND last_beat_at < ?")
    .all(cutoff);
  if (!dead.length) return 0;

  const offline = db.prepare("UPDATE servers SET status = 'offline', player_count = 0 WHERE id = ?");
  const clear = db.prepare('DELETE FROM server_players WHERE server_id = ?');
  for (const s of dead) {
    offline.run(s.id);
    clear.run(s.id);
  }
  return dead.length;
}

/** The numbers the dashboard shows at the top. */
export function liveSnapshot() {
  reapDeadServers();
  expirePunishments();
  const t = now();
  const dayAgo = t - 864e5;

  const live = db
    .prepare(
      `SELECT COUNT(*) AS servers,
              COALESCE(SUM(player_count), 0) AS players,
              COALESCE(SUM(max_players), 0)  AS capacity,
              AVG(fps)  AS avg_fps,
              AVG(ping) AS avg_ping
         FROM servers WHERE status = 'online'`
    )
    .get();

  const joins24 = db
    .prepare("SELECT COUNT(*) AS n FROM game_events WHERE type = 'join' AND created_at > ?")
    .get(dayAgo).n;
  const joins1h = db
    .prepare("SELECT COUNT(*) AS n FROM game_events WHERE type = 'join' AND created_at > ?")
    .get(t - 36e5).n;
  const uniques24 = db
    .prepare("SELECT COUNT(DISTINCT roblox_id) AS n FROM game_events WHERE type = 'join' AND created_at > ?")
    .get(dayAgo).n;

  const bans = db
    .prepare("SELECT COUNT(*) AS n FROM punishments WHERE type = 'ban' AND active = 1")
    .get().n;
  const bans24 = db
    .prepare("SELECT COUNT(*) AS n FROM punishments WHERE type = 'ban' AND issued_at > ?")
    .get(dayAgo).n;
  const actions24 = db
    .prepare('SELECT COUNT(*) AS n FROM punishments WHERE issued_at > ?')
    .get(dayAgo).n;

  const players = db.prepare('SELECT COUNT(*) AS n FROM players').get().n;
  const newPlayers24 = db.prepare('SELECT COUNT(*) AS n FROM players WHERE first_seen_at > ?').get(dayAgo).n;
  const appeals = db.prepare("SELECT COUNT(*) AS n FROM appeals WHERE status = 'pending'").get().n;
  const queued = db.prepare('SELECT COUNT(*) AS n FROM action_queue WHERE acked_at IS NULL').get().n;

  const peak = db
    .prepare('SELECT COALESCE(MAX(players), 0) AS n FROM stat_samples WHERE bucket > ?')
    .get(Math.floor(dayAgo / MINUTE)).n;

  return {
    at: t,
    servers: live.servers || 0,
    players: live.players || 0,
    capacity: live.capacity || 0,
    fill: live.capacity ? Math.round(((live.players || 0) / live.capacity) * 100) : 0,
    avgFps: live.avg_fps != null ? Math.round(live.avg_fps * 10) / 10 : null,
    avgPing: live.avg_ping != null ? Math.round(live.avg_ping) : null,
    joins1h,
    joins24,
    uniques24,
    peak24: Math.max(peak, live.players || 0),
    activeBans: bans,
    bans24,
    modActions24: actions24,
    knownPlayers: players,
    newPlayers24,
    pendingAppeals: appeals,
    queuedActions: queued,
  };
}

/** Per-minute history for the dashboard graph. */
export function history(minutes = 180) {
  const from = Math.floor((now() - minutes * MINUTE) / MINUTE);
  const rows = db
    .prepare(
      `SELECT bucket, players, servers, joins, leaves, bans, avg_fps, avg_ping
         FROM stat_samples WHERE bucket >= ? ORDER BY bucket ASC`
    )
    .all(from);
  return rows.map((r) => ({
    t: r.bucket * MINUTE,
    players: r.players,
    servers: r.servers,
    joins: r.joins,
    leaves: r.leaves,
    bans: r.bans,
    fps: r.avg_fps,
    ping: r.avg_ping,
  }));
}

/** Fold the current minute into stat_samples. Called on a timer. */
export function sampleNow() {
  reapDeadServers();
  const t = now();
  const bucket = Math.floor(t / MINUTE);
  const from = bucket * MINUTE;

  const live = db
    .prepare(
      `SELECT COUNT(*) AS servers, COALESCE(SUM(player_count),0) AS players,
              AVG(fps) AS avg_fps, AVG(ping) AS avg_ping
         FROM servers WHERE status = 'online'`
    )
    .get();
  const joins = db
    .prepare("SELECT COUNT(*) AS n FROM game_events WHERE type='join' AND created_at >= ?")
    .get(from).n;
  const leaves = db
    .prepare("SELECT COUNT(*) AS n FROM game_events WHERE type='leave' AND created_at >= ?")
    .get(from).n;
  const bans = db
    .prepare("SELECT COUNT(*) AS n FROM punishments WHERE type='ban' AND issued_at >= ?")
    .get(from).n;

  db.prepare(
    `INSERT INTO stat_samples (bucket, players, servers, joins, leaves, bans, avg_fps, avg_ping)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket) DO UPDATE SET
       players = MAX(stat_samples.players, excluded.players),
       servers = excluded.servers,
       joins   = excluded.joins,
       leaves  = excluded.leaves,
       bans    = excluded.bans,
       avg_fps = excluded.avg_fps,
       avg_ping= excluded.avg_ping`
  ).run(
    bucket,
    live.players || 0,
    live.servers || 0,
    joins,
    leaves,
    bans,
    live.avg_fps ?? null,
    live.avg_ping ?? null
  );
}

/** Housekeeping: trim history and finished queue rows so the file stays small. */
/**
 * Drop old screenshots, never the mutes themselves.
 *
 * The image is only needed while a mute could still be questioned; the record
 * that somebody was muted, why, and by whom has to follow them for good. So
 * this deletes bytes out of mute_evidence and leaves every chat_mutes row
 * exactly where it is.
 */
export function pruneEvidence() {
  const days = Number(getSetting('evidence_retention_days', '90'));
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = now() - days * 864e5;
  const info = db.prepare('DELETE FROM mute_evidence WHERE created_at < ?').run(cutoff);
  if (info.changes) console.log(`[prune] dropped ${info.changes} expired mute screenshot(s)`);
  return info.changes;
}

export function prune() {
  const t = now();
  pruneEvidence();
  db.prepare('DELETE FROM stat_samples WHERE bucket < ?').run(Math.floor((t - 30 * 864e5) / MINUTE));
  db.prepare('DELETE FROM game_events WHERE created_at < ?').run(t - 30 * 864e5);
  db.prepare('DELETE FROM action_queue WHERE acked_at IS NOT NULL AND acked_at < ?').run(t - 2 * 864e5);
  db.prepare('DELETE FROM action_queue WHERE expires_at IS NOT NULL AND expires_at < ?').run(t - 864e5);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
}

let timers = [];

export function startStatsLoop() {
  const tick = setInterval(() => {
    try {
      sampleNow();
      broadcast({ type: 'stats', stats: liveSnapshot() }, 10);
    } catch (err) {
      console.error('[stats] tick failed:', err.message);
    }
  }, 10_000);

  const housekeeping = setInterval(() => {
    try {
      prune();
    } catch (err) {
      console.error('[stats] prune failed:', err.message);
    }
  }, 60 * 60 * 1000);

  timers = [tick, housekeeping];
  return () => timers.forEach(clearInterval);
}

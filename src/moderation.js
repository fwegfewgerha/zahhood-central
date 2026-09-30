import { db, now, audit } from './db.js';
import { role as roleInfo } from './roles.js';
import { broadcast } from './realtime.js';

export const PUNISHMENT_TYPES = ['warn', 'mute', 'kick', 'ban'];

/** Expire anything whose clock ran out. Cheap enough to call on every read. */
export function expirePunishments() {
  const t = now();
  const changed = db
    .prepare(
      `UPDATE punishments SET active = 0
        WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?`
    )
    .run(t);
  return changed.changes;
}

/** The punishment that should currently keep a player out, or null. */
export function activeBan(robloxId) {
  expirePunishments();
  return (
    db
      .prepare(
        `SELECT * FROM punishments
          WHERE roblox_id = ? AND type = 'ban' AND active = 1
          ORDER BY (expires_at IS NULL) DESC, expires_at DESC
          LIMIT 1`
      )
      .get(robloxId) || null
  );
}

export function activeMute(robloxId) {
  expirePunishments();
  return (
    db
      .prepare(
        `SELECT * FROM punishments
          WHERE roblox_id = ? AND type = 'mute' AND active = 1
          ORDER BY (expires_at IS NULL) DESC, expires_at DESC
          LIMIT 1`
      )
      .get(robloxId) || null
  );
}

export function punishmentsFor(robloxId) {
  expirePunishments();
  return db
    .prepare('SELECT * FROM punishments WHERE roblox_id = ? ORDER BY issued_at DESC')
    .all(robloxId);
}

/**
 * Record a punishment and, when it needs to reach the game right now,
 * drop the matching command on the action queue for the server to pick up.
 */
export function issuePunishment({
  robloxId,
  username,
  type,
  reason,
  evidence = null,
  durationMs = null,
  actor = null,
  source = 'panel',
  serverId = null,
}) {
  if (!PUNISHMENT_TYPES.includes(type)) throw new Error(`unknown punishment type: ${type}`);
  const t = now();
  const expiresAt = durationMs && durationMs > 0 ? t + durationMs : null;

  const info = db
    .prepare(
      `INSERT INTO punishments
        (roblox_id, username, type, reason, evidence, issued_by, issued_by_name, issued_by_role,
         issued_at, expires_at, active, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      robloxId,
      username,
      type,
      reason,
      evidence,
      actor?.id ?? null,
      actor?.discord_username ?? (source === 'game' ? 'in-game' : 'system'),
      actor?.role ?? null,
      t,
      expiresAt,
      source
    );

  const id = Number(info.lastInsertRowid);
  const punishment = db.prepare('SELECT * FROM punishments WHERE id = ?').get(id);

  // Warnings and mutes are informational; kicks and bans have to be enforced.
  if (type === 'ban' || type === 'kick') {
    queueAction({
      serverId: serverId || currentServerOf(robloxId),
      robloxId,
      type: type === 'ban' ? 'ban' : 'kick',
      payload: {
        reason,
        expiresAt,
        punishmentId: id,
        issuedBy: punishment.issued_by_name,
      },
      actor,
    });
  }
  if (type === 'mute') {
    queueAction({
      serverId: serverId || currentServerOf(robloxId),
      robloxId,
      type: 'mute',
      payload: { reason, expiresAt, punishmentId: id },
      actor,
    });
  }

  db.prepare(
    `INSERT INTO game_events (server_id, roblox_id, username, type, detail, data, created_at)
     VALUES (?, ?, ?, 'moderation', ?, ?, ?)`
  ).run(
    serverId,
    robloxId,
    username,
    `${type} - ${reason}`,
    JSON.stringify({ punishmentId: id, type }),
    t
  );

  audit(actor, `punish.${type}`, `player:${robloxId}`, { reason, expiresAt, id });
  broadcast({ type: 'punishment', punishment: shapePunishment(punishment) }, 10);

  return punishment;
}

export function revokePunishment(punishmentId, actor, reason) {
  const p = db.prepare('SELECT * FROM punishments WHERE id = ?').get(punishmentId);
  if (!p) return { error: 'not_found' };
  if (!p.active) return { error: 'already_inactive' };

  // A staff member may only undo a punishment issued by someone below them.
  const issuerRank = p.issued_by_role ? roleInfo(p.issued_by_role).rank : 0;
  const actorRank = roleInfo(actor.role).rank;
  if (issuerRank >= actorRank && p.issued_by !== actor.id) {
    return { error: 'outranked', issuedByRole: p.issued_by_role };
  }

  const t = now();
  db.prepare(
    `UPDATE punishments
        SET active = 0, revoked_by = ?, revoked_by_name = ?, revoked_at = ?, revoke_reason = ?
      WHERE id = ?`
  ).run(actor.id, actor.discord_username, t, reason || null, punishmentId);

  if (p.type === 'ban' || p.type === 'mute') {
    queueAction({
      serverId: null,
      robloxId: p.roblox_id,
      type: p.type === 'ban' ? 'unban' : 'unmute',
      payload: { punishmentId, by: actor.discord_username },
      actor,
    });
  }

  audit(actor, 'punish.revoke', `punishment:${punishmentId}`, { reason });
  const updated = db.prepare('SELECT * FROM punishments WHERE id = ?').get(punishmentId);
  broadcast({ type: 'punishment_revoked', punishment: shapePunishment(updated) }, 10);
  return { punishment: updated };
}

// ---------------------------------------------------------------
// action queue - the panel's outbox to the live game
// ---------------------------------------------------------------
export function queueAction({ serverId = null, robloxId = null, type, payload = {}, actor = null, ttlMs = 30 * 60 * 1000 }) {
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO action_queue (server_id, roblox_id, type, payload, created_at, created_by, created_by_name, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      serverId,
      robloxId,
      type,
      JSON.stringify(payload),
      t,
      actor?.id ?? null,
      actor?.discord_username ?? 'system',
      t + ttlMs
    );
  return Number(info.lastInsertRowid);
}

/** Actions a given server should run next, marked as delivered. */
export function takeActions(serverId, limit = 25) {
  const t = now();
  const rows = db
    .prepare(
      `SELECT * FROM action_queue
        WHERE acked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND (server_id IS NULL OR server_id = ?)
        ORDER BY id ASC LIMIT ?`
    )
    .all(t, serverId, limit);

  if (rows.length) {
    const mark = db.prepare('UPDATE action_queue SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?');
    for (const r of rows) mark.run(t, r.id);
  }

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    robloxId: r.roblox_id,
    payload: safeJson(r.payload),
    createdAt: r.created_at,
    createdBy: r.created_by_name,
  }));
}

export function ackActions(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const t = now();
  const stmt = db.prepare('UPDATE action_queue SET acked_at = ? WHERE id = ? AND acked_at IS NULL');
  let n = 0;
  for (const id of ids) {
    const num = Number(id);
    if (Number.isInteger(num)) n += stmt.run(t, num).changes;
  }
  return n;
}

export function currentServerOf(robloxId) {
  const row = db
    .prepare('SELECT server_id FROM server_players WHERE roblox_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(robloxId);
  return row?.server_id ?? null;
}

// ---------------------------------------------------------------
export function shapePunishment(p) {
  if (!p) return null;
  const r = p.issued_by_role ? roleInfo(p.issued_by_role) : null;
  return {
    id: p.id,
    robloxId: p.roblox_id,
    username: p.username,
    type: p.type,
    reason: p.reason,
    evidence: p.evidence,
    issuedBy: p.issued_by_name,
    issuedByRole: p.issued_by_role,
    issuedByRoleName: r?.name ?? null,
    issuedByRoleColor: r?.color ?? null,
    issuedAt: p.issued_at,
    expiresAt: p.expires_at,
    permanent: p.type === 'ban' && p.expires_at === null,
    active: !!p.active,
    revokedBy: p.revoked_by_name,
    revokedAt: p.revoked_at,
    revokeReason: p.revoke_reason,
    source: p.source,
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** "7d", "30m", "2h", "perm" -> milliseconds (null = permanent). */
export function parseDuration(input) {
  if (input == null || input === '' || input === 'perm' || input === 'permanent') return null;
  if (typeof input === 'number') return input > 0 ? input : null;
  const m = String(input).trim().match(/^(\d+)\s*(s|m|h|d|w|mo)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const table = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6 };
  return n * (table[unit] || 6e4);
}

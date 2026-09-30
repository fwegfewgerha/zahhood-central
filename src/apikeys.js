import crypto from 'node:crypto';
import { db, now, audit } from './db.js';

const PREFIX = 'zhc_live_';

/**
 * Keys are shown exactly once, at creation. We only ever store a SHA-256 of
 * the key plus a short prefix so the list page can tell them apart.
 */
export function createKey({ label, scopes = 'game', actor }) {
  const secret = crypto.randomBytes(32).toString('base64url');
  const full = PREFIX + secret;
  const hash = hashKey(full);
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO api_keys (label, key_hash, prefix, scopes, created_by, created_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(label, hash, full.slice(0, PREFIX.length + 6), scopes, actor?.id ?? null, actor?.discord_username ?? 'system', t);
  audit(actor, 'apikey.create', `key:${info.lastInsertRowid}`, { label, scopes });
  return { id: Number(info.lastInsertRowid), label, scopes, key: full, createdAt: t };
}

export function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function listKeys() {
  return db
    .prepare(
      `SELECT id, label, prefix, scopes, created_by_name, created_at, last_used_at, use_count, revoked_at
         FROM api_keys ORDER BY id DESC`
    )
    .all()
    .map((k) => ({
      id: k.id,
      label: k.label,
      prefix: `${k.prefix}...`,
      scopes: k.scopes.split(',').filter(Boolean),
      createdBy: k.created_by_name,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      useCount: k.use_count,
      revoked: !!k.revoked_at,
      revokedAt: k.revoked_at,
    }));
}

export function revokeKey(id, actor) {
  const info = db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id);
  if (info.changes) audit(actor, 'apikey.revoke', `key:${id}`);
  return info.changes > 0;
}

/** Look a key up by its plaintext value and bump its usage counters. */
export function verifyKey(raw, requiredScope = 'game') {
  if (!raw || typeof raw !== 'string') return null;
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(raw.trim()));
  if (!row || row.revoked_at) return null;
  const scopes = row.scopes.split(',').map((s) => s.trim());
  if (!scopes.includes(requiredScope) && !scopes.includes('*')) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?').run(now(), row.id);
  return row;
}

/** Express middleware for every /api/game route. */
export function requireApiKey(scope = 'game') {
  return (req, res, next) => {
    const header =
      req.get('x-zhc-key') ||
      (req.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
      req.query.key;
    const key = verifyKey(header, scope);
    if (!key) {
      return res.status(401).json({ ok: false, error: 'invalid_api_key' });
    }
    req.apiKey = key;
    next();
  };
}

export function keyCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL').get().n;
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ============ staff / site accounts (Discord is the identity) ============
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id        TEXT    NOT NULL UNIQUE,
  discord_username  TEXT    NOT NULL,
  discord_global    TEXT,
  discord_avatar    TEXT,
  role              TEXT    NOT NULL DEFAULT 'member',
  roblox_user_id    INTEGER,
  roblox_username   TEXT,
  status            TEXT    NOT NULL DEFAULT 'active',
  created_at        INTEGER NOT NULL,
  last_login_at     INTEGER,
  last_seen_at      INTEGER,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ============ the player database ============
CREATE TABLE IF NOT EXISTS players (
  roblox_id        INTEGER PRIMARY KEY,
  username         TEXT NOT NULL,
  display_name     TEXT,
  account_age_days INTEGER DEFAULT 0,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  playtime_seconds INTEGER NOT NULL DEFAULT 0,
  join_count       INTEGER NOT NULL DEFAULT 0,
  cash             INTEGER NOT NULL DEFAULT 0,
  level            INTEGER NOT NULL DEFAULT 1,
  kills            INTEGER NOT NULL DEFAULT 0,
  deaths           INTEGER NOT NULL DEFAULT 0,
  robberies        INTEGER NOT NULL DEFAULT 0,
  arrests          INTEGER NOT NULL DEFAULT 0,
  crew             TEXT,
  last_server_id   TEXT,
  last_ip_hash     TEXT,
  device           TEXT,
  flags            TEXT NOT NULL DEFAULT '[]',
  data             TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_players_username  ON players(username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_players_iphash    ON players(last_ip_hash);

CREATE TABLE IF NOT EXISTS player_names (
  roblox_id  INTEGER NOT NULL,
  username   TEXT    NOT NULL,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (roblox_id, username)
);

-- ============ moderation ============
CREATE TABLE IF NOT EXISTS punishments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_id       INTEGER NOT NULL,
  username        TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  reason          TEXT    NOT NULL,
  evidence        TEXT,
  issued_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_by_name  TEXT,
  issued_by_role  TEXT,
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER,
  active          INTEGER NOT NULL DEFAULT 1,
  revoked_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_by_name TEXT,
  revoked_at      INTEGER,
  revoke_reason   TEXT,
  source          TEXT NOT NULL DEFAULT 'panel',
  delivered       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pun_player ON punishments(roblox_id, active);
CREATE INDEX IF NOT EXISTS idx_pun_issued ON punishments(issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_pun_active ON punishments(active, type);

CREATE TABLE IF NOT EXISTS appeals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  punishment_id   INTEGER NOT NULL REFERENCES punishments(id) ON DELETE CASCADE,
  roblox_id       INTEGER NOT NULL,
  discord_id      TEXT,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      INTEGER NOT NULL,
  handled_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_by_name TEXT,
  handled_at      INTEGER,
  response        TEXT
);

-- Roblox accounts a Discord user has proved they own. One person may link
-- several, which is both convenient for them and useful to staff: every
-- linked account is, by definition, a confirmed alt of the same person.
CREATE TABLE IF NOT EXISTS roblox_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roblox_id       INTEGER NOT NULL UNIQUE,
  roblox_username TEXT,
  verified_at     INTEGER NOT NULL,
  method          TEXT NOT NULL DEFAULT 'profile'
);
CREATE INDEX IF NOT EXISTS idx_links_user ON roblox_links(user_id);

-- The back-and-forth on an appeal. The player reaches this through a secret
-- token rather than an account; staff reach it from the panel.
CREATE TABLE IF NOT EXISTS appeal_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  appeal_id   INTEGER NOT NULL REFERENCES appeals(id) ON DELETE CASCADE,
  author_type TEXT    NOT NULL,          -- player | staff | system
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT,
  author_role TEXT,
  body        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  seen_by_player INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_appeal_msgs ON appeal_messages(appeal_id, id);

CREATE TABLE IF NOT EXISTS player_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_id   INTEGER NOT NULL,
  body        TEXT NOT NULL,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT,
  author_role TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_player ON player_notes(roblox_id, created_at DESC);

-- ============ live game link ============
CREATE TABLE IF NOT EXISTS servers (
  id             TEXT PRIMARY KEY,
  place_id       TEXT,
  region         TEXT,
  player_count   INTEGER NOT NULL DEFAULT 0,
  max_players    INTEGER NOT NULL DEFAULT 0,
  uptime_seconds INTEGER NOT NULL DEFAULT 0,
  fps            REAL,
  ping           REAL,
  memory_mb      REAL,
  version        TEXT,
  started_at     INTEGER,
  last_beat_at   INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'online'
);
CREATE INDEX IF NOT EXISTS idx_servers_beat ON servers(last_beat_at DESC);

CREATE TABLE IF NOT EXISTS server_players (
  server_id    TEXT    NOT NULL,
  roblox_id    INTEGER NOT NULL,
  username     TEXT    NOT NULL,
  display_name TEXT,
  team         TEXT,
  joined_at    INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (server_id, roblox_id)
);
CREATE INDEX IF NOT EXISTS idx_sp_player ON server_players(roblox_id);

CREATE TABLE IF NOT EXISTS action_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id       TEXT,
  roblox_id       INTEGER,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  delivered_at    INTEGER,
  acked_at        INTEGER,
  expires_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_queue_pending ON action_queue(acked_at, server_id);

CREATE TABLE IF NOT EXISTS game_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  TEXT,
  roblox_id  INTEGER,
  username   TEXT,
  type       TEXT NOT NULL,
  detail     TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time   ON game_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_player ON game_events(roblox_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type   ON game_events(type, created_at DESC);

CREATE TABLE IF NOT EXISTS stat_samples (
  bucket   INTEGER PRIMARY KEY,
  players  INTEGER NOT NULL DEFAULT 0,
  servers  INTEGER NOT NULL DEFAULT 0,
  joins    INTEGER NOT NULL DEFAULT 0,
  leaves   INTEGER NOT NULL DEFAULT 0,
  bans     INTEGER NOT NULL DEFAULT 0,
  avg_fps  REAL,
  avg_ping REAL
);

-- ============ staff chat ============
CREATE TABLE IF NOT EXISTS chat_channels (
  key      TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  topic    TEXT,
  min_rank INTEGER NOT NULL DEFAULT 10,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel       TEXT NOT NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name   TEXT NOT NULL,
  author_role   TEXT NOT NULL,
  author_avatar TEXT,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  deleted_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_channel ON chat_messages(channel, id DESC);

-- ============ game API keys ============
CREATE TABLE IF NOT EXISTS api_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  prefix          TEXT NOT NULL,
  scopes          TEXT NOT NULL DEFAULT 'game',
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  use_count       INTEGER NOT NULL DEFAULT 0,
  revoked_at      INTEGER
);

-- ============ access control ============
-- Only Discord IDs listed here may sign in at all (when enabled).
CREATE TABLE IF NOT EXISTS whitelist (
  discord_id    TEXT PRIMARY KEY,
  label         TEXT,
  note          TEXT,
  added_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_by_name TEXT,
  added_at      INTEGER NOT NULL
);

-- Site-wide settings the owner can flip without a redeploy.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER
);

-- Owner-editable display names/colors. Rank and key are never editable.
CREATE TABLE IF NOT EXISTS role_overrides (
  role_key   TEXT PRIMARY KEY,
  name       TEXT,
  color      TEXT,
  updated_by TEXT,
  updated_at INTEGER
);

-- Owner-set permission grants. A row here beats the default rank threshold.
CREATE TABLE IF NOT EXISTS role_permissions (
  role_key   TEXT    NOT NULL,
  permission TEXT    NOT NULL,
  allowed    INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER,
  PRIMARY KEY (role_key, permission)
);

-- Screenshots backing a chat mute. Kept as bytes rather than a link, because
-- Discord CDN URLs expire and the evidence would quietly rot. Stored here it
-- is replicated with the rest of the database and moves hosts with it.
CREATE TABLE IF NOT EXISTS mute_evidence (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mime         TEXT    NOT NULL,
  bytes        BLOB    NOT NULL,
  byte_size    INTEGER NOT NULL,
  sha256       TEXT    NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_name TEXT,
  created_at   INTEGER NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_evidence_unused ON mute_evidence(used, created_at);

-- Discord chat mutes, applied to your Discord server by the bot.
-- The moderator is recorded here but never sent to Discord, so a timeout
-- cannot be traced back to whoever ordered it from inside the server.
CREATE TABLE IF NOT EXISTS chat_mutes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id      TEXT    NOT NULL,
  discord_name    TEXT,
  reason          TEXT    NOT NULL,
  issued_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_by_name  TEXT,
  issued_by_role  TEXT,
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER,
  active          INTEGER NOT NULL DEFAULT 1,
  revoked_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_by_name TEXT,
  revoked_at      INTEGER,
  revoke_reason   TEXT,
  delivered       INTEGER NOT NULL DEFAULT 0,
  delivery_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_mutes_user   ON chat_mutes(discord_id, active);
CREATE INDEX IF NOT EXISTS idx_mutes_issued ON chat_mutes(issued_at DESC);

-- Website traffic: which pages signed-in people opened, and when.
CREATE TABLE IF NOT EXISTS page_views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  path       TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_views_user ON page_views(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_views_time ON page_views(created_at DESC);

-- Every rejected sign-in, for rate limiting and forensics.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT,
  username   TEXT,
  ip         TEXT,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_time ON login_attempts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_ip   ON login_attempts(ip, created_at DESC);

-- ============ audit ============
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  actor_role TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
`);

// Seed the default staff chat rooms once.
const channelCount = db.prepare('SELECT COUNT(*) AS n FROM chat_channels').get().n;
if (channelCount === 0) {
  const ins = db.prepare(
    'INSERT INTO chat_channels (key, name, topic, min_rank, position) VALUES (?, ?, ?, ?, ?)'
  );
  ins.run('general', 'general', 'Everyone on the team. Keep it civil.', 10, 1);
  ins.run('moderation', 'moderation', 'Punishment calls, second opinions, ban reviews.', 10, 2);
  ins.run('reports', 'reports', 'Player reports being worked right now.', 10, 3);
  ins.run('appeals', 'appeals', 'Appeal discussion before a verdict goes out.', 30, 4);
  ins.run('admin', 'admin-room', 'Administrator and above.', 50, 5);
  ins.run('command', 'high-command', 'Owner Assistant and above.', 70, 6);
  ins.run('owners', 'owners-only', 'Co-Owner, Creator and the Game Owner.', 80, 7);
}

// --- migrations for databases created by an earlier version ---
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] migrated: added ${table}.${column}`);
}
addColumnIfMissing('sessions', 'last_used_at', 'INTEGER');
addColumnIfMissing('appeals', 'token', 'TEXT');
addColumnIfMissing('appeals', 'closed_at', 'INTEGER');
addColumnIfMissing('appeals', 'roblox_username', 'TEXT');
addColumnIfMissing('punishments', 'appeal_code', 'TEXT');
addColumnIfMissing('users', 'roblox_verified_at', 'INTEGER');
addColumnIfMissing('users', 'roblox_verify_code', 'TEXT');
addColumnIfMissing('users', 'roblox_verify_target', 'INTEGER');
addColumnIfMissing('users', 'roblox_verify_expires', 'INTEGER');
addColumnIfMissing('chat_mutes', 'evidence_id', 'INTEGER');

// The whitelist is ON out of the box: a fresh install lets nobody in except
// the configured OWNER_DISCORD_ID until that owner adds people by hand.
const DEFAULT_SETTINGS = {
  whitelist_enabled: '1',
  // Whether banned players may open the appeal page at all.
  appeals_open: '1',
  // When on, an appellant must also type the short code from their ban
  // message. Without it, anyone who knows a username can read that player's
  // ban reason and evidence link. Off by default so the flow stays simple.
  appeal_require_code: '0',
  // Screenshots are dropped after this many days to keep the database small.
  // The mute itself is never deleted - somebody's record has to follow them.
  evidence_retention_days: '90',
};
const settingInsert = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  settingInsert.run(key, value, Date.now());
}

export const now = () => Date.now();

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value, actor) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(key, String(value), actor?.discord_username ?? 'system', Date.now());
}

export function isWhitelistEnabled() {
  return getSetting('whitelist_enabled', '1') === '1';
}

export function isWhitelisted(discordId) {
  if (!discordId) return false;
  return !!db.prepare('SELECT 1 AS x FROM whitelist WHERE discord_id = ?').get(String(discordId));
}

export function recordLoginAttempt({ discordId, username, ip, reason }) {
  db.prepare(
    'INSERT INTO login_attempts (discord_id, username, ip, reason, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(discordId ?? null, username ?? null, ip ?? null, reason, Date.now());
}

export function audit(actor, action, target, detail, ip) {
  db.prepare(
    `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, target, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actor?.id ?? null,
    actor?.discord_username ?? 'system',
    actor?.role ?? 'system',
    action,
    target ?? null,
    typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : null,
    ip ?? null,
    now()
  );
}

export function newId(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function jsonOr(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

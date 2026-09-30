/**
 * Dev-only seeder.
 *
 *   node scripts/dev-seed.js
 *
 * Creates a demo owner account with a ready-made login cookie, a game API
 * key, a couple of fake live servers full of players, and some punishment
 * history - so you can click through the whole panel before Discord OAuth
 * is wired up.
 *
 * It refuses to run when NODE_ENV=production.
 */
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { db, now, newId } from '../src/db.js';
import { createKey } from '../src/apikeys.js';
import { issuePunishment } from '../src/moderation.js';
import { sampleNow } from '../src/stats.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const t = now();

// ---------------------------------------------------------------
// 1. Demo staff accounts
// ---------------------------------------------------------------
const PEOPLE = [
  ['100000000000000001', 'zah', 'Zah', 'game_owner'],
  ['100000000000000002', 'deuce', 'Deuce', 'co_owner'],
  ['100000000000000003', 'mari', 'Mari', 'owner_assistant'],
  ['100000000000000004', 'trell', 'Trell', 'head_mod'],
  ['100000000000000005', 'kayy', 'Kayy', 'moderator'],
  ['100000000000000006', 'smoke', 'Smoke', 'chat_mod'],
  ['100000000000000007', 'newguy', 'NewGuy', 'member'],
];

const upsert = db.prepare(
  `INSERT INTO users (discord_id, discord_username, discord_global, role, created_at, last_login_at, last_seen_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(discord_id) DO UPDATE SET role = excluded.role`
);
for (const [discordId, username, global, role] of PEOPLE) {
  upsert.run(discordId, username, global, role, t, t, t);
}

const owner = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(PEOPLE[0][0]);

// A signed session cookie so you can open the panel without Discord.
const sid = newId(32);
db.prepare(
  'INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
).run(sid, owner.id, t, t + config.sessionTtlMs, '127.0.0.1', 'dev-seed');
const mac = crypto.createHmac('sha256', config.sessionSecret).update(sid).digest('base64url');
const cookie = `zhc_sid=${sid}.${mac}`;

// ---------------------------------------------------------------
// 2. A game key
// ---------------------------------------------------------------
const existingKey = db.prepare("SELECT id FROM api_keys WHERE label = 'dev-seed key' AND revoked_at IS NULL").get();
let apiKey = null;
if (!existingKey) {
  apiKey = createKey({ label: 'dev-seed key', actor: owner }).key;
}

// ---------------------------------------------------------------
// 3. Fake players, servers and history
// ---------------------------------------------------------------
const FIRST = ['lil', 'big', 'young', 'yb', 'kay', 'trey', 'dre', 'jay', 'zo', 'quan', 'rio', 'tez'];
const LAST = ['savage', 'opp', 'blocc', 'grind', 'stackz', 'racks', 'wave', 'drip', 'fyre', 'ghost'];

function makeName(i) {
  return `${FIRST[i % FIRST.length]}_${LAST[(i * 7) % LAST.length]}${(i * 13) % 97}`;
}

const players = [];
const insertPlayer = db.prepare(
  `INSERT INTO players (roblox_id, username, display_name, account_age_days, first_seen_at, last_seen_at,
                        playtime_seconds, join_count, cash, level, kills, deaths, robberies, arrests, crew,
                        last_ip_hash, device, flags)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(roblox_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
);

for (let i = 0; i < 64; i++) {
  const id = 3000000 + i * 4177;
  const username = makeName(i);
  const ipHash = i % 11 === 0 ? 'shared-fingerprint-a' : crypto.randomUUID().slice(0, 32);
  insertPlayer.run(
    id,
    username,
    username,
    30 + ((i * 37) % 1400),
    t - (i + 1) * 3600_000 * 9,
    t - (i % 9) * 600_000,
    600 + i * 911,
    3 + (i % 40),
    (i * 3137) % 90000,
    1 + (i % 45),
    (i * 7) % 220,
    (i * 5) % 180,
    (i * 3) % 60,
    (i * 2) % 30,
    i % 5 === 0 ? ['Eastside', 'Westside', 'Northend'][i % 3] : null,
    ipHash,
    ['Desktop', 'Mobile', 'Console', 'Tablet'][i % 4],
    i % 17 === 0 ? JSON.stringify(['suspected exploiter']) : '[]'
  );
  players.push({ id, username });
}

// Two live servers with rosters.
const SERVERS = [
  { id: 'a1f3c8e0-7b52-4d19-9c4a-0f2e6d81b7c3', region: 'US-East', max: 30 },
  { id: 'b7e2d419-3a86-4f70-8d21-5c9b4e0a6f18', region: 'EU-West', max: 30 },
];

const insertServer = db.prepare(
  `INSERT INTO servers (id, place_id, region, player_count, max_players, uptime_seconds, fps, ping, memory_mb, version, started_at, last_beat_at, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online')
   ON CONFLICT(id) DO UPDATE SET last_beat_at = excluded.last_beat_at, status = 'online'`
);
const insertPresence = db.prepare(
  `INSERT INTO server_players (server_id, roblox_id, username, display_name, team, joined_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(server_id, roblox_id) DO UPDATE SET updated_at = excluded.updated_at`
);
const insertEvent = db.prepare(
  `INSERT INTO game_events (server_id, roblox_id, username, type, detail, data, created_at)
   VALUES (?, ?, ?, ?, ?, '{}', ?)`
);

let cursor = 0;
SERVERS.forEach((s, si) => {
  const roster = players.slice(cursor, cursor + 14 + si * 4);
  cursor += roster.length;
  insertServer.run(
    s.id,
    config.roblox.placeId || '0',
    s.region,
    roster.length,
    s.max,
    3600 * (2 + si),
    58 + si,
    42 + si * 11,
    1800 + si * 240,
    '117',
    t - 3600_000 * (2 + si),
    t - 4000
  );
  roster.forEach((p, pi) => {
    insertPresence.run(s.id, p.id, p.username, p.username, ['Civilians', 'Crew', 'Police'][pi % 3], t - pi * 90_000, t);
    insertEvent.run(s.id, p.id, p.username, 'join', null, t - pi * 90_000);
  });
});

// Some scattered history so the graph and feed have shape.
for (let i = 0; i < 400; i++) {
  const p = players[i % players.length];
  const type = ['join', 'leave', 'kill', 'robbery', 'arrest'][i % 5];
  insertEvent.run(
    SERVERS[i % 2].id,
    p.id,
    p.username,
    type,
    type === 'robbery' ? 'Corner store' : type === 'arrest' ? 'Downtown' : null,
    t - i * 60_000 * 2
  );
}

// Punishment history.
const REASONS = [
  ['ban', 'Exploiting - fly + speed', '7d'],
  ['ban', 'Ban evasion on an alt', null],
  ['warn', 'Toxicity in chat', null],
  ['kick', 'Mic spam', null],
  ['mute', 'Slurs in chat', '1d'],
  ['ban', 'Scamming other players', '30d'],
  ['warn', 'Bypassing the chat filter', null],
];
const staffPool = db.prepare("SELECT * FROM users WHERE role != 'member'").all();

const already = db.prepare('SELECT COUNT(*) AS n FROM punishments').get().n;
if (already === 0) {
  REASONS.forEach((entry, i) => {
    const [type, reason, duration] = entry;
    const target = players[(i * 9) % players.length];
    const actor = staffPool[(i + 1) % staffPool.length];
    issuePunishment({
      robloxId: target.id,
      username: target.username,
      type,
      reason,
      durationMs: duration === '7d' ? 6048e5 : duration === '30d' ? 2592e6 : duration === '1d' ? 864e5 : null,
      actor,
      source: 'panel',
    });
  });

  // One appeal waiting on a decision.
  const ban = db.prepare("SELECT * FROM punishments WHERE type = 'ban' AND active = 1 LIMIT 1").get();
  if (ban) {
    db.prepare(
      `INSERT INTO appeals (punishment_id, roblox_id, discord_id, body, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).run(
      ban.id,
      ban.roblox_id,
      '100000000000000099',
      'it wasnt me it was my little brother on my account i swear. i already changed my password and it wont happen again, ive been playing this game since it came out please',
      t - 7200_000
    );
  }
}

// Staff chat starter messages.
if (db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n === 0) {
  const insertMsg = db.prepare(
    `INSERT INTO chat_messages (channel, user_id, author_name, author_role, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const seedChat = [
    ['general', 1, 'Zah', 'game_owner', 'panel is live. everybody link your roblox account under Staff Team so bans trace back to you properly', t - 5400_000],
    ['general', 4, 'Trell', 'head_mod', 'got it. EU server has been crashing every ~2h, keeping an eye on the fps graph', t - 5100_000],
    ['moderation', 5, 'Kayy', 'moderator', 'banned lil_savage13 for fly hacking, clip is in the evidence field', t - 3000_000],
    ['moderation', 3, 'Mari', 'owner_assistant', 'good call. if he comes back on an alt check the identity tab, it matches fingerprints', t - 2900_000],
  ];
  for (const m of seedChat) insertMsg.run(...m);
}

// Backfill the graph with a believable day.
const MINUTE = 60_000;
const sample = db.prepare(
  `INSERT INTO stat_samples (bucket, players, servers, joins, leaves, bans, avg_fps, avg_ping)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(bucket) DO NOTHING`
);
for (let m = 24 * 60; m >= 0; m--) {
  const bucket = Math.floor((t - m * MINUTE) / MINUTE);
  const hour = new Date(t - m * MINUTE).getUTCHours();
  const curve = Math.sin(((hour - 4) / 24) * Math.PI * 2) * 0.45 + 0.55;
  const base = Math.max(4, Math.round(30 * curve + Math.sin(m / 7) * 4));
  sample.run(bucket, base, Math.max(1, Math.ceil(base / 16)), Math.round(base / 6), Math.round(base / 7), m % 240 === 0 ? 1 : 0, 57 + (m % 5), 40 + (m % 19));
}
sampleNow();

// ---------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log('  Zah Hood Central - demo data loaded');
console.log('='.repeat(64));
console.log(`  Staff accounts   ${PEOPLE.length} (owner: ${owner.discord_username})`);
console.log(`  Players          ${players.length}`);
console.log(`  Live servers     ${SERVERS.length}`);
if (apiKey) console.log(`  Game API key     ${apiKey}`);
else console.log('  Game API key     (already exists - make a new one in the panel)');
console.log('\n  To browse the panel without Discord, set this cookie on');
console.log(`  ${config.baseUrl} and open ${config.baseUrl}/panel :\n`);
console.log(`    document.cookie = "${cookie}; path=/"`);
console.log('\n  Delete data/zahhood.db to wipe all of this.');
console.log('='.repeat(64) + '\n');

/**
 * Pretends to be a Roblox server so you can watch the panel move without
 * opening Studio. It speaks exactly the same API as ZahHoodCentral.server.lua.
 *
 *   node scripts/fake-server.js <api-key> [serverId] [playerCount]
 *
 * Leave it running and open the dashboard: players drift up and down, joins
 * and leaves land in the feed, and any kick/ban you issue from the panel shows
 * up here within one heartbeat.
 */
import { config } from '../src/config.js';

const [, , keyArg, serverArg, countArg] = process.argv;
const KEY = keyArg || process.env.ZHC_KEY;

if (!KEY) {
  console.error('Usage: node scripts/fake-server.js <api-key> [serverId] [playerCount]');
  console.error('Create a key in the panel (Game Connection) or run scripts/dev-seed.js.');
  process.exit(1);
}

const BASE = `${config.baseUrl}/api/game`;
const SERVER_ID = serverArg || `fake-${Math.random().toString(36).slice(2, 10)}`;
const TARGET = Number(countArg || 12);
const START = Date.now();

const NAMES = ['lil_', 'big_', 'young_', 'yb_', 'kay_', 'trey_', 'dre_', 'zo_', 'quan_', 'rio_'];
const TAGS = ['savage', 'blocc', 'grind', 'stackz', 'wave', 'drip', 'ghost', 'fyre'];

const roster = new Map();
let nextId = 8800000 + Math.floor(Math.random() * 1000) * 100;

function makePlayer() {
  const id = nextId++;
  const username = `${NAMES[id % NAMES.length]}${TAGS[id % TAGS.length]}${id % 100}`;
  return {
    userId: id,
    username,
    displayName: username,
    accountAge: 30 + (id % 1500),
    team: ['Civilians', 'Crew', 'Police'][id % 3],
    device: ['Desktop', 'Mobile', 'Console'][id % 3],
    joinedAt: Date.now(),
    stats: {
      cash: (id * 17) % 50000,
      level: 1 + (id % 40),
      kills: id % 120,
      deaths: id % 90,
      robberies: id % 25,
      arrests: id % 15,
      playtime: 0,
    },
  };
}

async function call(path, body, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-ZHC-Key': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function join() {
  const p = makePlayer();
  const res = await call('/join', { serverId: SERVER_ID, player: p });
  if (!res.allowed) {
    console.log(`  x ${p.username} was refused: ${res.ban?.reason}`);
    return;
  }
  roster.set(p.userId, p);
  console.log(`  + ${p.username} joined (${roster.size} in server)`);
}

async function leave(player) {
  roster.delete(player.userId);
  await call('/leave', {
    serverId: SERVER_ID,
    player,
    sessionSeconds: Math.floor((Date.now() - player.joinedAt) / 1000),
  });
  console.log(`  - ${player.username} left (${roster.size} in server)`);
}

function runAction(action) {
  const who = action.robloxId ? [...roster.values()].find((p) => p.userId === action.robloxId) : null;
  switch (action.type) {
    case 'kick':
      console.log(`  ! KICK ${who?.username ?? action.robloxId}: ${action.payload.reason}`);
      if (who) roster.delete(who.userId);
      break;
    case 'ban':
      console.log(`  ! BAN ${who?.username ?? action.robloxId}: ${action.payload.reason}`);
      if (who) roster.delete(who.userId);
      break;
    case 'unban':
      console.log(`  ! UNBAN ${action.robloxId}`);
      break;
    case 'mute':
      console.log(`  ! MUTE ${who?.username ?? action.robloxId}`);
      break;
    case 'message':
      console.log(`  > ANNOUNCEMENT from ${action.payload.from}: ${action.payload.message}`);
      break;
    case 'shutdown':
      console.log(`  ! SHUTDOWN requested by ${action.createdBy}: ${action.payload.reason}`);
      roster.clear();
      break;
    default:
      console.log(`  ? unknown action ${action.type}`);
  }
}

async function heartbeat() {
  const res = await call('/heartbeat', {
    serverId: SERVER_ID,
    placeId: config.roblox.placeId || '0',
    region: 'US-East',
    players: [...roster.values()],
    maxPlayers: 30,
    uptime: Math.floor((Date.now() - START) / 1000),
    fps: 55 + Math.random() * 5,
    ping: 35 + Math.random() * 25,
    memory: 1200 + Math.random() * 600,
    version: 'fake-1',
  });

  if (res.actions?.length) {
    for (const a of res.actions) runAction(a);
    await call('/ack', { ids: res.actions.map((a) => a.id) });
  }
}

async function churn() {
  // Drift toward the target population, with a bit of noise.
  const delta = TARGET - roster.size;
  const wantJoin = delta > 0 ? 0.8 : 0.2;
  if (Math.random() < wantJoin && roster.size < 30) {
    await join();
  } else if (roster.size > 0) {
    const list = [...roster.values()];
    await leave(list[Math.floor(Math.random() * list.length)]);
  }

  // Occasional gameplay events so the feed is not just joins.
  if (roster.size && Math.random() < 0.5) {
    const p = [...roster.values()][Math.floor(Math.random() * roster.size)];
    const type = ['robbery', 'arrest', 'kill'][Math.floor(Math.random() * 3)];
    await call('/events', {
      serverId: SERVER_ID,
      events: [{
        type,
        userId: p.userId,
        username: p.username,
        detail: { robbery: 'Corner store', arrest: 'Downtown', kill: 'drive-by' }[type],
      }],
    });
  }
}

// --- boot ---------------------------------------------------------
try {
  const ping = await call('/ping', null, 'GET');
  console.log(`\nConnected to ${config.baseUrl} with key "${ping.key}"`);
} catch (err) {
  console.error(`Could not reach ${BASE}: ${err.message}`);
  console.error('Is the server running? Is the key correct?');
  process.exit(1);
}

console.log(`Pretending to be server ${SERVER_ID}, aiming for ~${TARGET} players.`);
console.log('Ctrl+C to stop.\n');

for (let i = 0; i < Math.min(TARGET, 8); i++) await join();
await heartbeat();

setInterval(() => heartbeat().catch((e) => console.error('heartbeat:', e.message)), 5000);
setInterval(() => churn().catch((e) => console.error('churn:', e.message)), 3000);

process.on('SIGINT', async () => {
  console.log('\nShutting the fake server down...');
  for (const p of [...roster.values()]) {
    try { await leave(p); } catch { /* ignore */ }
  }
  process.exit(0);
});
